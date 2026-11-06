/**
 * generator.js — TGPanel Account Generator Service
 * Runs in Docker with Xvfb & Chromium + Buster extension.
 * Solves reCAPTCHA with Buster audio challenge, registers account on tgpanel.org,
 * and pushes the new account to the main bot's /api/add-accounts endpoint.
 */

'use strict';

require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Environment & Config ─────────────────────────────────────────────────────
const PORT             = process.env.PORT || 3001;
const SECRET           = process.env.GENERATOR_SECRET || '';
const BOT_API_URL      = (process.env.BOT_API_URL || '').replace(/\/$/, '');
const ADMIN_CHAT_ID    = process.env.ADMIN_CHAT_ID || '';
const BOT_TOKEN        = process.env.BOT_TOKEN || '';

const BUSTER_PATH      = path.join(__dirname, 'extensions', 'buster');
const CAPTCHA_TIMEOUT_SEC = 15;
const MAX_ATTEMPTS_PER_ACC = 5;

// Chrome executable detection
function getChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const candidates = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    return candidates.find(p => fs.existsSync(p));
}

const CHROME_PATH = getChromePath();
console.log(`[Config] Chrome path: ${CHROME_PATH || 'NOT FOUND'}`);
console.log(`[Config] Buster extension path: ${BUSTER_PATH} (exists: ${fs.existsSync(BUSTER_PATH)})`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateCredentials() {
    const hex = crypto.randomBytes(4).toString('hex');
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const prefix = letters[Math.floor(Math.random() * letters.length)] + letters[Math.floor(Math.random() * letters.length)];
    const username = `${prefix}${hex}`;
    const email = `${username}@gmail.com`;
    const password = 'Pass' + crypto.randomBytes(4).toString('hex') + 'A1!';
    return { username, email, password };
}

async function tgNotify(text) {
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text,
            parse_mode: 'HTML'
        }, { timeout: 8000 });
    } catch (_) {}
}

async function pushAccountsToBot(accounts) {
    if (!BOT_API_URL || !SECRET) {
        console.log('[Push] BOT_API_URL or GENERATOR_SECRET not configured. Accounts kept local.');
        return false;
    }
    try {
        const res = await axios.post(`${BOT_API_URL}/api/add-accounts`, {
            secret: SECRET,
            accounts
        }, { timeout: 15000 });
        console.log(`[Push] ✅ Bot accepted: +${res.data.added} accounts, total pool: ${res.data.pool}`);
        return true;
    } catch (err) {
        console.error(`[Push] ❌ Failed to push to bot: ${err.message}`);
        return false;
    }
}

// ─── Browser Automation Helpers ───────────────────────────────────────────────
async function hardPurgeEverything(page) {
    try {
        const client = await page.target().createCDPSession();
        await client.send('Storage.clearDataForOrigin', {
            origin: 'https://tgpanel.org',
            storageTypes: 'all'
        });
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
    } catch (e) {
        await page.evaluate(() => {
            try { localStorage.clear(); } catch(e) {}
            try { sessionStorage.clear(); } catch(e) {}
        }).catch(() => {});
    }
}

async function clickRecaptchaCheckbox(page) {
    try {
        for (const frame of page.frames()) {
            const isAnchor = frame.url().includes('recaptcha') && (frame.url().includes('anchor') || frame.url().includes('api2'));
            if (isAnchor) {
                const box = await frame.$('#recaptcha-anchor, .recaptcha-checkbox');
                if (box) {
                    await box.click();
                    return true;
                }
            }
        }
    } catch (_) {}
    return false;
}

async function clickBusterButton(page) {
    try {
        for (const frame of page.frames()) {
            const isBframe = frame.url().includes('recaptcha') && frame.url().includes('bframe');
            if (isBframe) {
                const busterBtn = await frame.$('#solver-button, .help-button-holder, .buster-button');
                if (busterBtn) {
                    await busterBtn.click();
                    return true;
                }
            }
        }
    } catch (_) {}
    return false;
}

async function isTryAgainLaterBlocked(page) {
    try {
        for (const frame of page.frames()) {
            if (frame.url().includes('recaptcha')) {
                const text = await frame.content().catch(() => '');
                if (text.includes('Try again later') || text.includes('automated queries')) {
                    return true;
                }
            }
        }
    } catch (_) {}
    return false;
}

async function attemptRegistration(page, creds) {
    await page.goto('https://tgpanel.org/signup', { waitUntil: 'domcontentloaded', timeout: 20000 });

    if (!page.url().includes('/signup')) {
        await hardPurgeEverything(page);
        await page.goto('https://tgpanel.org/signup', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    await page.waitForSelector('input[name="RegistrationForm[login]"]', { timeout: 10000 });

    await page.type('input[name="RegistrationForm[login]"]', creds.username, { delay: 5 });
    await page.type('input[name="RegistrationForm[email]"]', creds.email, { delay: 5 });
    await page.type('input[name="RegistrationForm[password]"]', creds.password, { delay: 5 });
    await page.type('input[name="RegistrationForm[password_again]"]', creds.password, { delay: 5 });

    // Click submit/signup button
    await page.evaluate(() => {
        const btn = document.querySelector('.signup-buttons button') ||
                    document.querySelector('form button[type="submit"]') ||
                    document.querySelector('.btn-primary');
        if (btn) btn.click();
    }).catch(() => {});

    const startTime = Date.now();
    let clickedCheckbox = false;
    let clickedBuster = false;
    let submitted = false;

    while (Date.now() - startTime < (CAPTCHA_TIMEOUT_SEC * 1000)) {
        await sleep(600);

        const currentUrl = page.url();
        if (!currentUrl.includes('/signup')) {
            return { success: true, url: currentUrl };
        }

        const content = await page.content().catch(() => '');
        if (content.includes('Sign out') || content.includes('/logout') || content.includes('id="user-dropdown"')) {
            return { success: true, url: currentUrl };
        }

        if (await isTryAgainLaterBlocked(page)) {
            console.log('[Block] Google displayed "Try again later". Purging session...');
            return { success: false, timeout: true };
        }

        if (!clickedCheckbox) {
            if (await clickRecaptchaCheckbox(page)) clickedCheckbox = true;
        }

        if (!clickedBuster) {
            if (await clickBusterButton(page)) clickedBuster = true;
        }

        const isSolved = await page.evaluate(() => {
            const gr = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
            return gr && gr.value && gr.value.trim().length > 20;
        }).catch(() => false);

        if (isSolved && !submitted) {
            console.log('[Solved] CAPTCHA cleared! Submitting registration...');
            await page.evaluate(() => {
                const btn = document.querySelector('.signup-buttons button') ||
                            document.querySelector('form button[type="submit"]');
                if (btn) btn.click();
            }).catch(() => {});
            submitted = true;
            await sleep(1500);
        }
    }

    if (!page.url().includes('/signup')) {
        return { success: true, url: page.url() };
    }

    return { success: false, timeout: true };
}

async function createOneAccount(page) {
    const creds = generateCredentials();
    console.log(`\n----------------------------------------`);
    console.log(`[Account] Creating: ${creds.username} (${creds.email})`);

    await hardPurgeEverything(page);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ACC; attempt++) {
        try {
            const res = await attemptRegistration(page, creds);
            if (res.success) {
                console.log(`[SUCCESS] Registered: ${creds.username}`);
                return { success: true, ...creds };
            }
            if (res.timeout) {
                await hardPurgeEverything(page);
                await sleep(1000);
            }
        } catch (e) {
            console.log(`[WARN] Attempt ${attempt} failed: ${e.message}`);
            await hardPurgeEverything(page);
            await sleep(1000);
        }
    }
    return { success: false, username: creds.username };
}

// ─── Job State & Worker ───────────────────────────────────────────────────────
let _jobRunning = false;
let _jobProgress = { target: 0, created: 0, failed: 0, current: 0 };

async function runGeneratorTask(count) {
    if (_jobRunning) return;
    _jobRunning = true;
    _jobProgress = { target: count, created: 0, failed: 0, current: 0 };

    console.log(`\n========================================`);
    console.log(`[Job Started] Target: ${count} accounts`);
    console.log(`========================================`);

    await tgNotify(`🚀 <b>TGPanel Account Generator Started</b>\nTarget: <b>${count}</b> fresh accounts`);

    let browser = null;
    const createdAccounts = [];

    try {
        if (!CHROME_PATH) throw new Error('No Chromium/Chrome executable found on system.');

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,800',
        ];

        if (fs.existsSync(BUSTER_PATH)) {
            launchArgs.push(`--disable-extensions-except=${BUSTER_PATH}`);
            launchArgs.push(`--load-extension=${BUSTER_PATH}`);
        }

        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false, // Display is handled by Xvfb virtual frame buffer
            defaultViewport: { width: 1280, height: 800 },
            ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
            args: launchArgs
        });

        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        for (let i = 0; i < count; i++) {
            _jobProgress.current = i + 1;
            console.log(`\n>>> Progress: ${i + 1}/${count} (Created: ${createdAccounts.length})`);

            const res = await createOneAccount(page);
            if (res.success) {
                _jobProgress.created++;
                const acc = { username: res.username, email: res.email, password: res.password };
                createdAccounts.push(acc);

                // Push in small batches of 3 or at the end so main bot gets them quickly
                if (createdAccounts.length % 3 === 0 || i === count - 1) {
                    const batch = createdAccounts.slice(Math.max(0, createdAccounts.length - 3));
                    await pushAccountsToBot(batch);
                }
            } else {
                _jobProgress.failed++;
            }

            if (i < count - 1) {
                await hardPurgeEverything(page);
                await sleep(1000);
            }
        }

        // Final push
        if (createdAccounts.length > 0 && createdAccounts.length % 3 !== 0) {
            const remainder = createdAccounts.length % 3;
            await pushAccountsToBot(createdAccounts.slice(-remainder));
        }

    } catch (err) {
        console.error(`[Job Error] ${err.message}`);
        await tgNotify(`❌ <b>Generator Error:</b> ${err.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        _jobRunning = false;
        console.log(`\n[Job Completed] Created: ${createdAccounts.length}/${count}`);
        await tgNotify(`🏁 <b>Generator Completed!</b>\nCreated: <b>${createdAccounts.length}</b>\nFailed: <b>${_jobProgress.failed}</b>`);
    }
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// 1. Health check
app.get('/', (req, res) => {
    res.json({
        service: 'free-smm-generator',
        status: 'online',
        jobRunning: _jobRunning,
        progress: _jobProgress
    });
});

// 2. Start generation: POST /generate or GET /generate?secret=...&count=10
app.all('/generate', (req, res) => {
    const body = req.method === 'POST' ? req.body : {};
    const secret = body.secret || req.query.secret;
    const count = parseInt(body.count || req.query.count, 10) || 10;

    if (!SECRET || secret !== SECRET) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized. Check GENERATOR_SECRET.' });
    }

    if (count < 1 || count > 100) {
        return res.status(400).json({ status: 'error', message: 'count must be between 1 and 100' });
    }

    if (_jobRunning) {
        return res.status(409).json({ 
            status: 'busy', 
            message: 'A generation job is already running.',
            progress: _jobProgress 
        });
    }

    // Launch async
    runGeneratorTask(count).catch(err => console.error('[Fatal]', err));

    res.json({
        status: 'started',
        message: `Started generating ${count} accounts. Accounts will be pushed to main bot as they are ready.`,
        target: count
    });
});

// 3. Status check
app.get('/status', (req, res) => {
    res.json({
        jobRunning: _jobRunning,
        progress: _jobProgress
    });
});

app.listen(PORT, () => {
    console.log(`[HTTP] Generator server listening on port ${PORT}`);
    console.log(`[HTTP] Connected bot URL: ${BOT_API_URL || '(none)'}`);
});

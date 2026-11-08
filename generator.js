/**
 * generator.js — Turbo Account Generator Service
 * Exact port of local turbo_single_runner.js for Railway Docker (Xvfb + Chromium + Buster)
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
let BOT_API_URL        = (process.env.BOT_API_URL || '').trim().replace(/\/$/, '');
if (BOT_API_URL && !BOT_API_URL.startsWith('http://') && !BOT_API_URL.startsWith('https://')) {
    BOT_API_URL = 'https://' + BOT_API_URL;
}
const ADMIN_CHAT_ID    = process.env.ADMIN_CHAT_ID || '';
const BOT_TOKEN        = process.env.BOT_TOKEN || '';

const BUSTER_PATH      = path.join(__dirname, 'extensions', 'buster');
const FAST_CAPTCHA_TIMEOUT_SECONDS = 14;
const MAX_ATTEMPTS_PER_ACCOUNT = 8;

// Chrome detection
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
console.log(`[Config] Buster extension: ${BUSTER_PATH} (exists: ${fs.existsSync(BUSTER_PATH)})`);

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
        console.log('[Push] BOT_API_URL or GENERATOR_SECRET not configured.');
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

// ─── Browser Automation (Turbo Single Runner Exact Logic) ─────────────────────
async function hardPurgeEverything(page) {
    try {
        const client = await page.target().createCDPSession();
        await client.send('Storage.clearDataForOrigin', {
            origin: 'https://tgpanel.org',
            storageTypes: 'all'
        });
        await client.send('Storage.clearDataForOrigin', {
            origin: 'https://www.google.com',
            storageTypes: 'all'
        });
        await client.send('Storage.clearDataForOrigin', {
            origin: 'https://recaptcha.net',
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

async function is404Page(page) {
    try {
        const title = await page.title().catch(() => '');
        if (title.includes('404')) return true;

        const content = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            return h1 ? h1.innerText : document.body.innerText;
        }).catch(() => '');

        if (content.includes('404') && content.includes('not found')) {
            return true;
        }
    } catch(e) {}
    return false;
}

async function clickRecaptchaCheckbox(page) {
    try {
        const frames = page.frames();
        for (const frame of frames) {
            const isAnchor = frame.url().includes('recaptcha') && (frame.url().includes('anchor') || frame.url().includes('api2'));
            if (isAnchor) {
                const box = await frame.$('#recaptcha-anchor, .recaptcha-checkbox');
                if (box) {
                    await box.click();
                    return true;
                }
            }
        }
    } catch(e) {}
    return false;
}

async function clickBusterButton(page) {
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('recaptcha') && frame.url().includes('bframe')) {
                const busterBtn = await frame.$('#solver-button, .help-button-holder, .buster-button');
                if (busterBtn) {
                    await busterBtn.click();
                    return true;
                }
            }
        }
    } catch(e) {}
    return false;
}

async function clickReloadCaptchaButton(page) {
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('recaptcha') && frame.url().includes('bframe')) {
                const reloadBtn = await frame.$('#recaptcha-reload-button, .rc-button-reload');
                if (reloadBtn) {
                    await reloadBtn.click();
                    return true;
                }
            }
        }
    } catch(e) {}
    return false;
}

async function isTryAgainLaterBlocked(page) {
    try {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('recaptcha')) {
                const text = await frame.content().catch(() => '');
                if (text.includes('Try again later') || text.includes('automated queries')) {
                    return true;
                }
            }
        }
    } catch(e) {}
    return false;
}

async function attemptRegistration(page, creds) {
    const navResponse = await page.goto('https://tgpanel.org/signup', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);

    // Instant 404 detection via HTTP status code or page content
    if ((navResponse && navResponse.status() === 404) || (await is404Page(page))) {
        process.stdout.write('[404 Instant Reset] ');
        await hardPurgeEverything(page);
        return { success: false, timeout: true };
    }

    if (!page.url().includes('/signup')) {
        await hardPurgeEverything(page);
        await page.goto('https://tgpanel.org/signup', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
        if (await is404Page(page)) {
            process.stdout.write('[404 Instant Reset] ');
            return { success: false, timeout: true };
        }
    }

    try {
        await page.waitForSelector('input[name="RegistrationForm[login]"]', { timeout: 4000 });
    } catch(e) {
        if (await is404Page(page)) {
            process.stdout.write('[404 Instant Reset] ');
            await hardPurgeEverything(page);
            return { success: false, timeout: true };
        }
        throw e;
    }

    // Direct in-DOM instant population (0ms delay)
    await page.evaluate((c) => {
        const set = (name, val) => {
            const el = document.querySelector(`input[name="RegistrationForm[${name}]"]`);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
        set('login', c.username);
        set('email', c.email);
        set('password', c.password);
        set('password_again', c.password);

        const btn = document.querySelector('.signup-buttons button') ||
                    document.querySelector('form button[type="submit"]') ||
                    document.querySelector('.btn-primary');
        if (btn) btn.click();
    }, creds);

    const clickTime = Date.now();
    let clickedCheckbox = false;
    let lastBusterClick = 0;
    let submitted = false;

    while (Date.now() - clickTime < (FAST_CAPTCHA_TIMEOUT_SECONDS * 1000)) {
        await sleep(150);

        const currentUrl = page.url();

        if (await is404Page(page)) {
            process.stdout.write('[404 Instant Reset] ');
            await hardPurgeEverything(page);
            return { success: false, timeout: true };
        }

        if (!currentUrl.includes('/signup')) {
            return { success: true, url: currentUrl };
        }

        const content = await page.content().catch(() => '');
        if (content.includes('Sign out') || content.includes('/logout') || content.includes('id="user-dropdown"')) {
            return { success: true, url: currentUrl };
        }

        if (await isTryAgainLaterBlocked(page)) {
            const reloaded = await clickReloadCaptchaButton(page);
            if (reloaded) {
                process.stdout.write('🔄 ');
                await sleep(800);
            }
            if (await isTryAgainLaterBlocked(page)) {
                return { success: false, rateLimited: true, timeout: true };
            }
        }

        if (!clickedCheckbox) {
            const ok = await clickRecaptchaCheckbox(page);
            if (ok) clickedCheckbox = true;
        }

        if (Date.now() - lastBusterClick > 1200) {
            const bOk = await clickBusterButton(page);
            if (bOk) lastBusterClick = Date.now();
        }

        const isSolved = await page.evaluate(() => {
            const gr = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
            return gr && gr.value && gr.value.trim().length > 20;
        }).catch(() => false);

        if (isSolved && !submitted) {
            await page.evaluate(() => {
                const btn = document.querySelector('.signup-buttons button') ||
                            document.querySelector('form button[type="submit"]');
                if (btn) btn.click();
            }).catch(() => {});
            submitted = true;
            await sleep(800);
        }
    }

    if (!page.url().includes('/signup') && !(await is404Page(page))) {
        return { success: true, url: page.url() };
    }

    return { success: false, timeout: true };
}

async function createOneAccount(page) {
    const creds = generateCredentials();
    console.log(`\n----------------------------------------`);
    console.log(`[Target] ${creds.username} (${creds.email})`);

    await hardPurgeEverything(page);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ACCOUNT; attempt++) {
        try {
            const res = await attemptRegistration(page, creds);
            if (res.success) {
                console.log(`\n⚡ [SUCCESS] Registered: ${creds.username}`);
                return { success: true, ...creds };
            }

            if (res.rateLimited) {
                process.stdout.write(`↺[RateLimit #${attempt}] `);
                await hardPurgeEverything(page);
                await sleep(1000);
                if (attempt >= 2) {
                    return { success: false, rateLimited: true, username: creds.username };
                }
                continue;
            }

            if (res.timeout) {
                process.stdout.write('↺ ');
                await hardPurgeEverything(page);
                await sleep(1500);
            }
        } catch (e) {
            await hardPurgeEverything(page);
            await sleep(1200);
        }
    }

    console.log(`\n❌ [Skipped] Could not register ${creds.username}`);
    return { success: false, username: creds.username };
}

// ─── Job State & Worker ───────────────────────────────────────────────────────
let _jobRunning = false;
let _stopRequested = false;
let _jobProgress = { target: 0, created: 0, failed: 0, current: 0 };

async function runGeneratorTask(count) {
    if (_jobRunning) return;
    _jobRunning = true;
    _stopRequested = false;
    _jobProgress = { target: count, created: 0, failed: 0, current: 0 };

    console.log(`\n========================================`);
    console.log(`[Job Started] Target: ${count} accounts`);
    console.log(`========================================`);

    await tgNotify(`🚀 <b>Generator Task Started</b>\nTarget: <b>${count}</b> fresh accounts`);

    let browser = null;
    const createdAccounts = [];
    let consecutiveBlocks = 0;

    try {
        if (!CHROME_PATH) throw new Error('No Chromium executable found.');

        const launchArgs = [
            '--start-maximized',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-session-crashed-bubble',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--blink-settings=imagesEnabled=true'
        ];

        if (fs.existsSync(BUSTER_PATH)) {
            launchArgs.push(`--disable-extensions-except=${BUSTER_PATH}`);
            launchArgs.push(`--load-extension=${BUSTER_PATH}`);
        }

        browser = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: false,
            defaultViewport: null,
            ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
            args: launchArgs
        });

        const pages = await browser.pages();
        let page = pages.length > 0 ? pages[0] : await browser.newPage();
        await page.bringToFront().catch(() => {});

        let attemptCount = 0;
        const maxAttempts = count * 4;

        while (createdAccounts.length < count && attemptCount < maxAttempts) {
            if (_stopRequested) {
                console.log(`\n🛑 [Job Stopped] Abort requested by user.`);
                break;
            }

            attemptCount++;
            _jobProgress.current = createdAccounts.length + 1;
            console.log(`\n>>> Progress: ${createdAccounts.length}/${count} Target Accounts (Attempt #${attemptCount})`);

            // Periodic memory cleanup every 25 attempts
            if (attemptCount > 0 && attemptCount % 25 === 0) {
                try {
                    console.log(`[Maintenance] Refreshing browser tab to free memory...`);
                    const freshPage = await browser.newPage();
                    await page.close().catch(() => {});
                    page = freshPage;
                    await page.bringToFront().catch(() => {});
                } catch (e) {
                    console.log(`[Maintenance] Page refresh note: ${e.message}`);
                }
            }

            const res = await createOneAccount(page);
            if (res.success) {
                consecutiveBlocks = 0; // reset block counter
                _jobProgress.created++;
                const acc = { username: res.username, email: res.email, password: res.password };
                createdAccounts.push(acc);

                // Push immediately to main bot
                await pushAccountsToBot([acc]);

                if (createdAccounts.length < count) {
                    await hardPurgeEverything(page);
                    const pauseMs = 1500 + Math.floor(Math.random() * 1000);
                    await sleep(pauseMs);
                }
            } else {
                _jobProgress.failed++;

                if (res.rateLimited) {
                    console.log(`\n⚡ [Instant Reset] Rate limit detected — clearing all storage & switching to fresh session...`);
                    await hardPurgeEverything(page);
                    try {
                        const oldPage = page;
                        page = await browser.newPage();
                        await oldPage.close().catch(() => {});
                    } catch (_) {}
                    await sleep(1500);
                } else if (createdAccounts.length < count) {
                    await hardPurgeEverything(page);
                    await sleep(1000);
                }
            }
        }

    } catch (err) {
        console.error(`[Job Error] ${err.message}`);
        await tgNotify(`❌ <b>Generator Error:</b> ${err.message}`);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        _jobRunning = false;
        _stopRequested = false;
        console.log(`\n[Job Completed] Created: ${createdAccounts.length}/${count}`);
        await tgNotify(`🏁 <b>Generator Completed!</b>\nCreated: <b>${createdAccounts.length}</b>\nFailed: <b>${_jobProgress.failed}</b>`);
    }
}

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        service: 'free-smm-generator',
        status: 'online',
        jobRunning: _jobRunning,
        progress: _jobProgress
    });
});

app.all('/generate', (req, res) => {
    const body = req.method === 'POST' ? req.body : {};
    const secret = body.secret || req.query.secret;
    const count = parseInt(body.count || req.query.count, 10) || 10;

    if (!SECRET || secret !== SECRET) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized. Check GENERATOR_SECRET.' });
    }

    if (count < 1 || count > 1000) {
        return res.status(400).json({ status: 'error', message: 'count must be between 1 and 1000' });
    }

    if (_jobRunning) {
        return res.status(409).json({ 
            status: 'busy', 
            message: 'A generation job is already running.',
            progress: _jobProgress 
        });
    }

    runGeneratorTask(count).catch(err => console.error('[Fatal]', err));

    res.json({
        status: 'started',
        message: `Started generating ${count} accounts. Accounts will be pushed to main bot as they are ready.`,
        target: count
    });
});

app.all('/stop', (req, res) => {
    const body = req.method === 'POST' ? req.body : {};
    const secret = body.secret || req.query.secret;

    if (!SECRET || secret !== SECRET) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized. Check GENERATOR_SECRET.' });
    }

    if (!_jobRunning) {
        return res.json({ status: 'idle', message: 'No generation job is currently running.' });
    }

    _stopRequested = true;
    res.json({
        status: 'stopping',
        message: 'Stopping generation job gracefully...',
        progress: _jobProgress
    });
});

app.get('/status', (req, res) => {
    res.json({
        jobRunning: _jobRunning,
        progress: _jobProgress
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Generator server listening on 0.0.0.0:${PORT}`);
    console.log(`[HTTP] Connected bot URL: ${BOT_API_URL || '(none)'}`);
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function extractFunction(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('missing function ' + name);
    let i = src.indexOf('{', start);
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unclosed function ' + name);
}

function loadPure() {
    const start = script.indexOf('/* EASY_PURE_START */');
    const end = script.indexOf('/* EASY_PURE_END */');
    assert(start >= 0 && end > start, 'pure markers missing');
    const context = { console };
    vm.createContext(context);
    vm.runInContext([
        extractFunction(script, 'validTankReading'),
        extractFunction(script, 'getTankUsage'),
        script.slice(start, end)
    ].join('\n'), context);
    return context;
}

function emptyRows(n) {
    return Array.from({ length: n }, () => api.rowFromParts('', '', '', ''));
}

function put(rows, idx, side, raw, inferred) {
    const fields = api.fieldsForReading(idx, side, raw, inferred);
    rows[idx] = api.rowFromParts(
        fields['soft_ab_a_' + idx],
        fields['soft_ab_b_' + idx],
        fields['soft_ab_swap_a_' + idx],
        fields['soft_ab_swap_b_' + idx]
    );
}

const READINGS = [
    [16, 'b', '1.74'],
    [17, 'a', '0.95'],
    [18, 'a', '10.11'],
    [19, 'b', '6.56'],
    [20, 'a', '4.65'],
    [21, 'b', '3.3'],
    [22, 'a', '0.22'],
    [23, 'a', '11.6'],
    [24, 'b', '12'],
    [25, 'a', '10.44'],
    [26, 'a', '1.38']
];
const EXPECTED = ['12.79', '14.84', '15.55', '13.91', '13.35', '15.08', '12.62', '11.60', '13.56', '9.06'];
const WASH = [
    'B 洗 1 支',
    'A 洗 1 支、B 洗 1 支',
    'A 洗 1 支',
    'B 洗 1 支',
    'A 洗 1 支',
    'B 洗 1 支',
    'A 洗 1 支、B 洗 1 支',
    'A 洗 1 支',
    'B 洗 1 支',
    '這一期沒有逆洗'
];

let api;

function runPureTests() {
    api = loadPure();
    assert(script.includes('每桶 12 升'), 'old dual field copy was changed');
    assert(script.includes('A剩餘(升)'), 'old admin labels were changed');
    assert(!script.includes("items.push") && script.includes("{ id: 'soft_ab', label: '小支軟水A/B', type: 'dual' }"), 'soft_ab item was changed');

    const rows = emptyRows(32);
    put(rows, 16, 'b', '1.74', { swapA: 0, swapB: 0 });
    assert(rows[16].bRaw === '1.74' && rows[16].aRaw === '12', 'baseline storage ' + JSON.stringify(rows[16]));

    for (let i = 1; i < READINGS.length; i++) {
        const [idx, side, raw] = READINGS[i];
        const loc = api.locatePrevious(rows, idx, null, null);
        assert(!loc.none && loc.adjacent, 'previous row for ' + idx + ' ' + JSON.stringify(loc));
        const resolved = api.resolveActiveTank(loc.rows, loc.index, idx, null);
        assert(!resolved.ambiguous, 'ambiguous at ' + idx + ' ' + JSON.stringify(resolved));
        const inf = api.inferEasySwap(resolved.side, resolved.remain, side, Number(raw));
        const projected = api.projectedUsage(rows[loc.index], side, raw, inf);
        assert(projected != null && Math.abs(projected - inf.usage) < 0.001, 'formula/table mismatch at ' + idx + ' formula ' + inf.usage + ' table ' + projected);
        assert(inf.usage.toFixed(2) === EXPECTED[i - 1], 'step ' + idx + ' got ' + inf.usage.toFixed(2));
        assert(inf.washText === WASH[i - 1], 'wash ' + idx + ' got ' + inf.washText);
        if (inf.needsDoubleConfirm) assert(inf.kind === 'double', 'double flag');
        put(rows, idx, side, raw, inf);
    }

    for (let i = 0; i < EXPECTED.length; i++) {
        const d = 16 + i;
        const ua = api.getTankUsage(rows[d].aRaw, rows[d + 1].aRaw, rows[d + 1].swapARaw);
        const ub = api.getTankUsage(rows[d].bRaw, rows[d + 1].bRaw, rows[d + 1].swapBRaw);
        assert(ua != null && ub != null, 'null tank usage at ' + d + ' ' + ua + ' ' + ub);
        const total = ((ua || 0) + (ub || 0)).toFixed(2);
        assert(total === EXPECTED[i], 'table row ' + d + ' got ' + total + ' A ' + ua + ' B ' + ub);
    }

    const mistakeB = api.getTankUsage('1.74', '12', '0');
    const mistakeA = api.getTankUsage('12', '0.95', '0');
    assert(mistakeB === null, 'explicit 0 swaps that go negative must still be blank, got ' + mistakeB);
    assert(mistakeA === 11.05, 'A portion of the mistaken row ' + mistakeA);
    assert(((mistakeA || 0) + (mistakeB || 0)).toFixed(2) === '11.05', 'mistaken total should stay 11.05');
    assert(api.getTankUsage('1.74', '12', '1') === 1.74, 'corrected B swap');

    assert(api.getTankUsage('10', '4', '') === 6, 'legacy drawdown changed');
    assert(api.getTankUsage('2', '11', '') === 3, 'legacy refill changed');

    const activeFull = api.inferActiveTank(rows, 24, null, null);
    assert(activeFull.side === 'b' && activeFull.remain === 12 && activeFull.source === 'this-swap', '10/25 active tank ' + JSON.stringify(activeFull));

    const partial = [api.rowFromParts('3', '4', '', '')];
    const amb = api.inferActiveTank(partial, 0, null, null);
    assert(amb.ambiguous && amb.reason === 'both-partial', JSON.stringify(amb));
    const staff = api.resolveActiveTank(partial, 0, null, 'b');
    assert(staff.side === 'b' && staff.remain === 4 && staff.source === 'staff', JSON.stringify(staff));

    const walked = api.inferActiveTank([
        api.rowFromParts('5', '12', '0', '0'),
        api.rowFromParts('12', '12', '0', '0')
    ], 1, null, null);
    assert(walked.side === 'a' && walked.source === 'walk-back', JSON.stringify(walked));

    const fromNext = api.inferActiveTank([
        api.rowFromParts('12', '12', '', ''),
        api.rowFromParts('12', '4', '1', '0')
    ], 0, null, null);
    assert(fromNext.side === 'a' && fromNext.source === 'next-swap', JSON.stringify(fromNext));
    const skipped = api.inferActiveTank([
        api.rowFromParts('12', '12', '', ''),
        api.rowFromParts('12', '4', '1', '0')
    ], 0, null, 1);
    assert(skipped.ambiguous, 'replacing the next row should ask instead of trusting it ' + JSON.stringify(skipped));

    const curr = emptyRows(3);
    const prev = emptyRows(32);
    prev[31] = api.rowFromParts('12', '6', '0', '1');
    const bridge = api.locatePrevious(curr, 1, prev, 31);
    assert(bridge.bridge && bridge.index === 31, JSON.stringify(bridge));
    assert(api.resolveActiveTank(bridge.rows, bridge.index, null, null).side === 'b', 'bridge active side');
    prev[30] = api.rowFromParts('8', '12', '0', '0');
    const monthStart = api.locatePrevious(curr, 0, prev, 31);
    assert(monthStart.index === 30 && !monthStart.bridge, 'day 1 must use last month, not the duplicate 次月1號 row ' + monthStart.index);

    const meta = api.previousMonthMeta('2026-01');
    assert(meta.key === '2025-12' && meta.days === 31, JSON.stringify(meta));

    const unchanged = api.inferEasySwap('a', 12, 'a', 12);
    assert(unchanged.usage === 0 && unchanged.swapA === 0 && unchanged.swapB === 0 && unchanged.kind === 'unchanged', JSON.stringify(unchanged));

    const gapped = [api.rowFromParts('12', '5', '0', '0'), api.rowFromParts('', '', '', ''), api.rowFromParts('', '', '', '')];
    const gap = api.locatePrevious(gapped, 2, null, null);
    assert(gap.index === 0 && gap.adjacent === false, JSON.stringify(gap));
    assert(api.inferEasySwap('b', 5, 'a', 4).usage === 13, 'gap usage');

    console.log('pure tests ok');
}

function chromePath() {
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome'].find((p) => fs.existsSync(p));
}

function startServer(pageHtml) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(pageHtml);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function runBrowserTests() {
    const chromeBin = chromePath();
    if (!chromeBin) {
        console.log('browser tests skipped: chrome not installed');
        return;
    }
    const pageHtml = html.replace(/<script src=[^>]*><\/script>/g, '');
    const server = await startServer(pageHtml);
    const port = server.address().port;
    const debugPort = 9400 + Math.floor(Math.random() * 200);
    const profile = fs.mkdtempSync('/tmp/easy-meter-chrome-');
    const chrome = spawn(chromeBin, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=' + debugPort,
        '--user-data-dir=' + profile,
        'about:blank'
    ], { stdio: 'ignore' });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function getJson(pathname) {
        const res = await fetch('http://127.0.0.1:' + debugPort + pathname);
        if (!res.ok) throw new Error(pathname + ' ' + res.status);
        return await res.json();
    }

    let ws;
    try {
        let version;
        for (let i = 0; i < 50; i++) {
            try { version = await getJson('/json/version'); break; } catch (e) { await sleep(100); }
        }
        assert(version && version.webSocketDebuggerUrl, 'chrome devtools did not start');
        const browserWs = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { browserWs.onopen = resolve; browserWs.onerror = reject; });
        let msgId = 0;
        const pending = new Map();
        const events = [];
        browserWs.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) {
                const item = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
                else item.resolve(msg.result);
            } else if (msg.method) events.push(msg);
        };
        function send(method, params = {}, sessionId) {
            const id = ++msgId;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                const payload = { id, method, params };
                if (sessionId) payload.sessionId = sessionId;
                browserWs.send(JSON.stringify(payload));
            });
        }
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        ws = { send: (method, params) => send(method, params, sessionId), browserWs, chrome };

        await ws.send('Page.enable');
        await ws.send('Runtime.enable');
        await ws.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `window.__confirms = [];
window.__posts = [];
window.confirm = function (msg) { window.__confirms.push(String(msg)); return true; };
window.fetch = async function (url, opts) {
  const method = opts && opts.method ? String(opts.method).toUpperCase() : 'GET';
  if (method === 'POST') {
    window.__posts.push(JSON.parse(opts.body));
    return { json: async () => ({ status: 'success' }) };
  }
  return { json: async () => ({}) };
};`
        });

        async function open(search) {
            await ws.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/index.html' + search });
            for (let i = 0; i < 50; i++) {
                const state = await ws.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
                if (state.result.value === 'complete') return;
                await sleep(100);
            }
            throw new Error('page did not load');
        }
        async function evaluate(expression) {
            const result = await ws.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
                timeout: 60000
            });
            if (result.exceptionDetails) {
                throw new Error(JSON.stringify(result.exceptionDetails, null, 2));
            }
            return result.result.value;
        }

        await open('');
        const acceptance = await evaluate(`(async () => {
            async function waitReady() {
                const started = Date.now();
                while (!easyCloudReady) {
                    if (Date.now() - started > 8000) throw new Error('cloud ready timeout');
                    await new Promise((r) => setTimeout(r, 20));
                }
            }
            loadTargetMonth('2026-10');
            await waitReady();
            if (!String(dates[16]).startsWith('10/17')) throw new Error('unexpected calendar ' + dates[16]);
            const readings = ${JSON.stringify(READINGS)};
            const expected = ${JSON.stringify(EXPECTED)};
            const wash = ${JSON.stringify(WASH)};
            const summaries = [];
            for (let i = 0; i < readings.length; i++) {
                const [idx, side, raw] = readings[i];
                document.getElementById('adminEasyDate').value = String(idx);
                easySidePick.admin = side;
                paintEasyTanks('admin');
                document.getElementById('adminEasyRemain').value = raw;
                await refreshEasyPreview('admin');
                const usage = document.getElementById('adminEasyUsage') ? document.getElementById('adminEasyUsage').textContent : '';
                const washText = document.getElementById('adminEasyWash') ? document.getElementById('adminEasyWash').textContent : '';
                const summary = document.getElementById('adminEasySummary').innerText;
                const disabled = document.getElementById('adminEasySubmit').disabled;
                summaries.push({ idx, usage, washText, disabled, summary });
                if (i > 0) {
                    if (usage !== expected[i - 1] + ' 噸') throw new Error('summary usage ' + idx + ' ' + usage + ' / ' + summary);
                    if (washText !== wash[i - 1]) throw new Error('summary wash ' + idx + ' ' + washText);
                }
                if (disabled) throw new Error('submit disabled at ' + idx + ' ' + summary);
                await submitEasyFromPrefix('admin');
            }
            const usages = [];
            const master = [];
            const headers = Array.from(document.querySelectorAll('#masterTable thead th')).map((th) => th.textContent);
            const col = headers.findIndex((text) => text.includes('小支軟水'));
            for (let d = 16; d <= 25; d++) {
                usages.push(document.getElementById('usage_soft_ab_total_' + d).innerText);
                const row = document.querySelector('#masterTableBody tr[data-date-idx="' + d + '"]');
                master.push(row.children[col].textContent);
            }
            document.getElementById('adminEasyRemain').value = '13';
            easySidePick.admin = 'a';
            await refreshEasyPreview('admin');
            const rejectsHigh = document.getElementById('adminEasySubmit').disabled === true;
            return {
                summaries,
                usages,
                master,
                col,
                headerCount: headers.filter((text) => text.includes('小支軟水')).length,
                confirms: window.__confirms,
                posts: window.__posts,
                rejectsHigh,
                stored: {
                    b16: document.getElementById('soft_ab_b_16').value,
                    a16: document.getElementById('soft_ab_a_16').value,
                    swapB17: document.getElementById('soft_ab_swap_b_17').value,
                    swapA17: document.getElementById('soft_ab_swap_a_17').value,
                    a24: document.getElementById('soft_ab_a_24').value,
                    b24: document.getElementById('soft_ab_b_24').value,
                    swapA24: document.getElementById('soft_ab_swap_a_24').value,
                    swapB24: document.getElementById('soft_ab_swap_b_24').value,
                    a26: document.getElementById('soft_ab_a_26').value,
                    swapA26: document.getElementById('soft_ab_swap_a_26').value,
                    swapB26: document.getElementById('soft_ab_swap_b_26').value
                },
                oldHead: document.querySelector('#tab-soft_ab thead').innerText,
                easyIntro: document.querySelector('#tab-soft-ab-easy h2').innerText
            };
        })()`);

        assert(acceptance.usages.join(',') === EXPECTED.join(','), 'device tab usages ' + acceptance.usages.join(','));
        assert(acceptance.master.join(',') === EXPECTED.join(','), 'master usages ' + acceptance.master.join(','));
        assert(acceptance.headerCount === 1, 'master gained an extra soft_ab column');
        assert(acceptance.oldHead.includes('剩餘(升)') && acceptance.oldHead.includes('逆洗'), 'old tab head changed: ' + acceptance.oldHead);
        assert(acceptance.rejectsHigh, '13 tons was accepted');
        assert(acceptance.confirms.length === 2, 'double-swap confirms ' + JSON.stringify(acceptance.confirms));
        assert(acceptance.confirms[0].includes('14.84') && acceptance.confirms[1].includes('12.62'), JSON.stringify(acceptance.confirms));
        assert(acceptance.stored.b16 === '1.74' && acceptance.stored.a16 === '12', JSON.stringify(acceptance.stored));
        assert(acceptance.stored.swapA17 === '0' && acceptance.stored.swapB17 === '1', JSON.stringify(acceptance.stored));
        assert(acceptance.stored.a24 === '12' && acceptance.stored.b24 === '12', JSON.stringify(acceptance.stored));
        assert(acceptance.stored.swapA24 === '1' && acceptance.stored.swapB24 === '0', JSON.stringify(acceptance.stored));
        assert(acceptance.stored.a26 === '1.38' && acceptance.stored.swapA26 === '0' && acceptance.stored.swapB26 === '0', JSON.stringify(acceptance.stored));
        const second = acceptance.posts[1];
        assert(second.meta_month === '2026-10', JSON.stringify(second));
        assert(second.soft_ab_a_17 === '0.95' && second.soft_ab_b_17 === '12', JSON.stringify(second));
        assert(second.soft_ab_swap_a_17 === '0' && second.soft_ab_swap_b_17 === '1', JSON.stringify(second));
        assert(acceptance.posts.length === READINGS.length, 'post count ' + acceptance.posts.length);

        const gap = await evaluate(`(async () => {
            async function waitReady() {
                const started = Date.now();
                while (!easyCloudReady) {
                    if (Date.now() - started > 8000) throw new Error('cloud ready timeout');
                    await new Promise((r) => setTimeout(r, 20));
                }
            }
            loadTargetMonth('2026-10');
            await waitReady();
            document.getElementById('adminEasyDate').value = '2';
            easySidePick.admin = 'b';
            document.getElementById('adminEasyRemain').value = '5';
            await submitEasyFromPrefix('admin');
            document.getElementById('adminEasyDate').value = '4';
            easySidePick.admin = 'a';
            document.getElementById('adminEasyRemain').value = '4';
            await refreshEasyPreview('admin');
            return document.getElementById('adminEasySummary').innerText;
        })()`);
        assert(gap.includes('13.00') && gap.includes('空日') && gap.includes('B 洗 1 支'), gap);

        const ambiguous = await evaluate(`(async () => {
            async function waitReady() {
                const started = Date.now();
                while (!easyCloudReady) {
                    if (Date.now() - started > 8000) throw new Error('cloud ready timeout');
                    await new Promise((r) => setTimeout(r, 20));
                }
            }
            loadTargetMonth('2026-10');
            await waitReady();
            document.getElementById('soft_ab_a_5').value = '12';
            document.getElementById('soft_ab_b_5').value = '12';
            document.getElementById('adminEasyDate').value = '6';
            easySidePick.admin = 'a';
            document.getElementById('adminEasyRemain').value = '10';
            await refreshEasyPreview('admin');
            const asked = document.getElementById('adminEasySummary').innerText;
            chooseEasyAmbiguous('admin', 'b');
            await refreshEasyPreview('admin');
            const after = document.getElementById('adminEasySummary').innerText;
            document.getElementById('adminEasyRemain').value = '9';
            await refreshEasyPreview('admin');
            const remembered = document.getElementById('adminEasySummary').innerText;
            return { asked, after, remembered };
        })()`);
        assert(ambiguous.asked.includes('請選一次') || ambiguous.asked.includes('要先確認上一筆'), ambiguous.asked);
        assert(ambiguous.after.includes('14.00') && ambiguous.after.includes('B 洗 1 支'), ambiguous.after);
        assert(ambiguous.remembered.includes('15.00') && !ambiguous.remembered.includes('請選一次'), ambiguous.remembered);

        await open('?qr=soft_ab');
        const oldField = await evaluate(`(async () => {
            const started = Date.now();
            while (!document.getElementById('fieldVal_a')) {
                if (Date.now() - started > 8000) throw new Error('old field did not open');
                await new Promise((r) => setTimeout(r, 20));
            }
            return {
                title: document.getElementById('field-device-title').innerText,
                sub: document.getElementById('field-device-subtitle').innerText,
                html: document.getElementById('field-inputs-container').innerText,
                date: document.getElementById('fieldDateLabel').innerText,
                onclick: document.getElementById('fieldSubmitBtn').getAttribute('onclick')
            };
        })()`);
        assert(oldField.title === '小支軟水A/B', JSON.stringify(oldField));
        assert(oldField.sub === '現場數據雲端直傳', oldField.sub);
        assert(oldField.html.includes('升') && oldField.html.includes('逆洗') && !oldField.html.includes('噸'), oldField.html);
        assert(oldField.date.includes('選擇填報日期'), oldField.date);
        assert(oldField.onclick === 'submitFieldData()', oldField.onclick);

        await open('?qr=soft_ab_easy');
        const easyField = await evaluate(`(async () => {
            async function waitReady() {
                const started = Date.now();
                while (!easyCloudReady) {
                    if (Date.now() - started > 8000) throw new Error('easy field cloud timeout');
                    await new Promise((r) => setTimeout(r, 20));
                }
            }
            await waitReady();
            chooseEasySide('field', 'b');
            document.getElementById('fieldEasyRemain').value = '1.74';
            await refreshEasyPreview('field');
            openQrModal();
            const cards = Array.from(document.querySelectorAll('#qrPrintArea h3')).map((el) => el.textContent);
            return {
                title: document.getElementById('field-device-title').innerText,
                sub: document.getElementById('field-device-subtitle').innerText,
                dateLabel: document.getElementById('fieldDateLabel').innerText,
                selected: dates[document.getElementById('fieldTargetDate').value],
                expected: dates[defaultEasyDateIndex()],
                summary: document.getElementById('fieldEasySummary').innerText,
                cards,
                url: document.getElementById('adminEasyUrl') ? document.getElementById('adminEasyUrl').textContent : ''
            };
        })()`);
        assert(easyField.title.includes('新版抄表'), easyField.title);
        assert(easyField.sub.includes('只填螢幕上正在跑的那一桶'), easyField.sub);
        assert(easyField.dateLabel.includes('預設明天'), easyField.dateLabel);
        assert(easyField.selected === easyField.expected, easyField.selected + ' vs ' + easyField.expected);
        assert(easyField.summary.includes('尚無上一筆') && easyField.summary.includes('1.74'), easyField.summary);
        assert(easyField.cards.includes('小支軟水A/B') && easyField.cards.includes('小支軟水A/B（新版抄表）'), easyField.cards.join('|'));
        const easyAt = easyField.cards.indexOf('小支軟水A/B（新版抄表）');
        const oldAt = easyField.cards.indexOf('小支軟水A/B');
        assert(easyAt === oldAt + 1, 'QR order ' + easyField.cards.join('|'));

        console.log('browser tests ok');
    } finally {
        if (ws && ws.browserWs) ws.browserWs.close();
        chrome.kill('SIGKILL');
        server.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

(async () => {
    runPureTests();
    await runBrowserTests();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

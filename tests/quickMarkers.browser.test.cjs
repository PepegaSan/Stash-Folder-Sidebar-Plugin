// Run with Playwright available in NODE_PATH (or PLAYWRIGHT_MODULE).
// The test server exposes only this checkout. Every Stash API is mocked in the fixture.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser, server, origin;
const root = path.resolve(__dirname, '..');
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const content = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': ({'.js':'text/javascript','.html':'text/html','.css':'text/css'})[path.extname(file)] || 'application/octet-stream' }).end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_CHROME || undefined });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function open(mode, extra = '') {
  const context = await browser.newContext({ viewport:{width:1180,height:800}, locale:'de-DE' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/tests/fixtures/quickMarkers.html?mode=' + mode + extra);
  await page.getByRole('button', { name:'Anfang markieren', exact:true }).waitFor();
  return {page, context, errors};
}
const position = async (page, at) => page.locator('#position').fill(String(at));
const main = page => page.getByRole('button', { name:/^(Anfang markieren|Ende markieren & speichern|Wird gespeichert …)$/ });
async function mount(page, mode, id) {
  await page.evaluate(({mode,id})=>window[mode==='classic'?'mountClassic':'mountStashUI'](id),{mode,id});
}

for (const mode of ['classic','stashui']) {
  test(`${mode}: a second open tab follows the draft, preset and discard without reloading`, async () => {
    const {page, context} = await open(mode);
    try {
      const other = await context.newPage();
      await other.goto(page.url());
      await main(other).waitFor();
      await main(page).click();
      await other.getByRole('button',{name:'Zum gespeicherten Anfang',exact:true}).waitFor({timeout:2500});
      await other.getByRole('button',{name:'Anpassen · Presets & Werkzeuge',exact:true}).click();
      if (mode === 'classic') await other.evaluate(() => testClassicKey('shift+2'));
      else await other.keyboard.press('Shift+Digit2');
      await page.getByText(/Anfang bei .*Favourite/).waitFor({timeout:2500});
      await page.getByRole('button',{name:'Verwerfen',exact:true}).click();
      await other.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor({timeout:2500});
      await main(page).click();
      assert.equal(await page.evaluate(() => QuickMarkersGuide.draft('scene-a').preset.primaryTag), 'Favourite');
    } finally { await context.close(); }
  });

  test(`${mode}: mark, pause, reload, change scene, return and save exactly one range`, async () => {
    const {page, context, errors} = await open(mode);
    try {
      assert.equal(await page.getByRole('button',{name:/^(Copy|Kopieren)$/}).count(), 0);
      await position(page,12.5);
      await main(page).click();
      await page.getByText('2 von 2 · Ende wählen',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Pause',exact:true}).click();
      assert.equal(await page.evaluate(()=>testState.paused),true);
      await page.reload();
      await page.getByRole('button',{name:'Zum gespeicherten Anfang',exact:true}).waitFor();
      await mount(page,mode,'scene-b');
      await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      await mount(page,mode,'scene-a');
      await page.getByRole('button',{name:'Zum gespeicherten Anfang',exact:true}).click();
      assert.equal(await page.evaluate(()=>testVideo.currentTime),12.5);
      await position(page,14.75);
      await main(page).click();
      await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>testState.markers.map(m=>({scene:m.scene_id,start:m.seconds,end:m.end_seconds,tag:m.primary_tag_id}))),
        [{scene:'scene-a',start:12.5,end:14.75,tag:'Compilation'}]);
      assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  });

  test(`${mode}: two tabs finishing the same draft during a delayed save create one marker`, async () => {
    const { page, context } = await open(mode);
    try {
      await main(page).click();
      const other = await context.newPage();
      await other.goto(page.url());
      await other.getByRole('button',{name:'Ende markieren & speichern',exact:true}).waitFor();
      await position(page,20);
      await position(other,22);
      await page.evaluate(() => { testState.hold = true; });
      await main(page).click();
      await page.waitForFunction(() => !!window.releaseSave);
      await main(other).click();
      await page.evaluate(() => releaseSave());
      for (const tab of [page, other]) await tab.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      assert.equal(await page.evaluate(() => testState.markers.length), 1);
      assert.equal(await other.evaluate(() => testState.markers.length), 0);
    } finally { await context.close(); }
  });

  test(`${mode}: invalid end and discard never create a marker`, async () => {
    const {page,context,errors} = await open(mode);
    try {
      await main(page).click();
      await position(page,5);
      await main(page).click();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.evaluate(()=>testState.markers.length),0);
      assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a').start),12);
      await page.getByRole('button',{name:'Verwerfen',exact:true}).click();
      await page.reload();
      await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  });

  test(`${mode}: failed save keeps the draft, repeated clicks and an info-bar remount save once`, async () => {
    const {page,context,errors} = await open(mode);
    try {
      await main(page).click();
      await position(page,20);
      await page.evaluate(()=>{testState.fail=true;});
      await main(page).click();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a').start),12);
      await page.evaluate(()=>{testState.hold=true;});
      await main(page).evaluate(button=>{button.click();button.click();});
      await page.getByRole('button',{name:'Wird gespeichert …',exact:true}).waitFor();
      await mount(page,mode,'scene-a');
      await page.getByRole('button',{name:'Wird gespeichert …',exact:true}).waitFor();
      await page.waitForFunction(()=>!!window.releaseSave);
      await page.evaluate(()=>releaseSave());
      await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>testState.markers.length),1);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  });

  test(`${mode}: preset choice and hotkeys still work in the simple view`, async () => {
    const {page,context,errors} = await open(mode);
    try {
      if(mode==='classic') await page.evaluate(()=>testClassicKey('shift+2'));
      else await page.keyboard.press('Shift+Digit2');
      await main(page).click();
      assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a').preset.primaryTag),'Favourite');
      await page.reload();
      await page.getByRole('button',{name:'Zum gespeicherten Anfang',exact:true}).waitFor();
      await position(page,25);
      await page.locator('h1').click(); // Player shortcuts intentionally ignore focused text inputs.
      if(mode==='classic') await page.evaluate(()=>testClassicKey('shift+o'));
      else await page.keyboard.press('Shift+O');
      await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>testState.markers[0].primary_tag_id),'Favourite');
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  });
}

test('Stash UI: the video guide works with controls hidden and shares its draft across sidebar remounts', async () => {
  const {page, context} = await open('stashui', '&player=1');
  try {
    const video = page.locator('.kb-screen > .qm-x-video-panel');
    await video.getByRole('button',{name:'Anfang markieren',exact:true}).click();
    await video.getByRole('button',{name:'Ende markieren & speichern',exact:true}).click();
    assert.match(await video.getByRole('status').innerText(),/Anfang/);
    await video.getByRole('button',{name:'Verwerfen',exact:true}).click();
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
    await video.getByRole('button',{name:'Anfang markieren',exact:true}).click();
    await page.locator('.kb-topbar').evaluate(el=>{el.hidden=false;});
    await page.getByRole('button',{name:'Quick Markers',exact:true}).click();
    const panel = page.locator('[data-side] > details:first-child');
    await panel.getByRole('button',{name:'Ende markieren & speichern',exact:true}).waitFor();
    await mount(page,'stashui','scene-a');
    assert.equal(await page.locator('.qm-x-open').count(),1);
    assert.equal(await video.count(),1);
    await position(page,24);
    await video.getByRole('button',{name:'Ende markieren & speichern',exact:true}).click();
    await panel.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>testState.markers.length),1);
  } finally { await context.close(); }
});

test('Stash UI: the title moves without folding, remembers the drop across scenes and reloads, and resets', async () => {
  const {page, context, errors} = await open('stashui', '&player=1');
  try {
    const panel = page.locator('.qm-x-video-panel'), title = panel.locator('summary');
    const action = panel.getByRole('button',{name:'Anfang markieren',exact:true});
    const box = () => panel.boundingBox();
    const near = (a,b) => assert(Math.abs(a.x-b.x)<1 && Math.abs(a.y-b.y)<1, JSON.stringify({actual:a,expected:b}));
    async function drag(dx,dy) {
      const b = await title.boundingBox(), x = b.x+b.width/2, y = b.y+b.height/2;
      await page.mouse.move(x,y); await page.mouse.down();
      await page.mouse.move(x+dx,y+dy,{steps:5}); await page.mouse.up();
    }
    const original = await box();
    await drag(170,65);
    const dropped = await box();
    near(dropped,{x:original.x+170,y:original.y+65});
    assert(await action.isVisible());
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
    await mount(page,'stashui','scene-b'); await action.waitFor(); near(await box(),dropped);
    await page.reload(); await action.waitFor(); near(await box(),dropped);
    await title.click();
    assert.equal(await action.isVisible(),false);
    await drag(4000,4000); // pointer capture continues past the edge; a closed panel stays closed.
    assert.equal(await action.isVisible(),false);
    await page.setViewportSize({width:570,height:600});
    const frame = await page.locator('.kb-screen').boundingBox();
    const edge = await box();
    assert(Math.abs(edge.x+edge.width-(frame.x+frame.width-1))<1);
    assert(Math.abs(edge.y+edge.height-(frame.y+frame.height-1))<1);
    await panel.locator('.qm-x-video-grip').dblclick();
    assert.equal(await action.isVisible(),false);
    await page.setViewportSize({width:1180,height:800});
    await page.reload(); await title.waitFor();
    assert.equal(await action.isVisible(),false);
    await title.focus(); await page.keyboard.press('Enter'); await action.waitFor();
    near(await box(),original);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); }
});

test('Stash UI: missing-tag retry retains the chosen times and re-enables the guide', async () => {
  const {page,context,errors} = await open('stashui');
  try {
    await page.keyboard.press('Shift+Digit3');
    await main(page).click(); await position(page,24); await main(page).click();
    await page.waitForFunction(()=>!!testState.action);
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a').start),12);
    await page.evaluate(()=>testState.action.run());
    await page.getByRole('button',{name:'Anfang markieren',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>testState.markers[0].end_seconds),24);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); }
});

test('simple guide fits a phone and exposes the old tools only after Adjust', async () => {
  const {page,context,errors} = await open('stashui');
  try {
    await page.setViewportSize({width:390,height:844});
    await main(page).click();
    assert.equal(await page.getByRole('button',{name:'Kopieren',exact:true}).isVisible(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.TEST_OUTPUT) {
      await fs.mkdir(process.env.TEST_OUTPUT,{recursive:true});
      await page.screenshot({path:path.join(process.env.TEST_OUTPUT,'quick-markers-einfach.png'),fullPage:true});
    }
    await page.getByRole('button',{name:'Anpassen · Presets & Werkzeuge',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Kopieren',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'Einfach anzeigen',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Kopieren',exact:true}).isVisible(),false);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); }
});

test('classic: Adjust exposes the existing controls and returns to one main action', async () => {
  const {page,context,errors} = await open('classic');
  try {
    await page.getByRole('button',{name:'Anpassen · Presets & Werkzeuge',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Out',exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'+ Instant',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'Einfach anzeigen',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Out',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  } finally { await context.close(); }
});

test('classic: configured collapsed panel still offers the next action and opens its guide', async () => {
  const context=await browser.newContext({locale:'de-DE'}),page=await context.newPage();
  try {
    await page.goto(origin+'/tests/fixtures/quickMarkers.html?mode=classic&collapsed=1');
    await page.locator('.quick-markers-panel-collapsed').waitFor();
    await page.getByRole('button',{name:'Anfang markieren',exact:true}).click();
    await page.getByText('2 von 2 · Ende wählen',{exact:true}).waitFor();
    assert.equal(await page.locator('.quick-markers-panel-collapsed').count(),0);
    assert.equal(await page.getByRole('button',{name:'Verwerfen',exact:true}).isVisible(),true);
  } finally {await context.close();}
});

test('classic: mounting a forced touch bar on a mouse desktop keeps the floating panel usable', async () => {
  const context = await browser.newContext({viewport:{width:1280,height:800},locale:'de-DE'});
  try {
    const page = await context.newPage();
    await page.goto(origin+'/tests/fixtures/quickMarkers.html?mode=classic&touch=1');
    const panel = page.locator('.quick-markers-panel');
    const bar = page.locator('.quick-markers-touch-bar');
    await bar.waitFor();
    await panel.getByRole('button',{name:'Anfang markieren',exact:true}).click();
    await bar.getByRole('button',{name:'Ende markieren & speichern',exact:true}).waitFor();
    await panel.getByRole('button',{name:'Verwerfen',exact:true}).click();
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
  } finally { await context.close(); }
});

test('classic: touch bar has one guide, with a visible discard action in landscape', async () => {
  const context=await browser.newContext({viewport:{width:844,height:390},isMobile:true,hasTouch:true,locale:'de-DE'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(origin+'/tests/fixtures/quickMarkers.html?mode=classic&touch=1');
    await page.locator('.quick-markers-touch-bar .quick-markers-guide-primary').waitFor();
    assert.equal(await page.locator('.quick-markers-panel').count(),0);
    await main(page).click();
    await page.getByRole('button',{name:'Verwerfen',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a').start),12);
    if(process.env.TEST_OUTPUT) await page.screenshot({path:path.join(process.env.TEST_OUTPUT,'quick-markers-touch.png'),fullPage:true});
    await page.getByRole('button',{name:'Verwerfen',exact:true}).click();
    assert.equal(await page.evaluate(()=>QuickMarkersGuide.draft('scene-a')),null);
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

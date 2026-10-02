const { CDP, getWsUrl } = require('./cdp-client');

async function main() {
  const ws = await getWsUrl();
  const cdp = new CDP(ws);
  await cdp.connect();
  console.log('Clicking Refresh Now button...');
  await cdp.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const r = btns.find(b => b.textContent && b.textContent.includes('Refresh Now'));
      if (r) r.click();
    })()
  `);
  console.log('Waiting 3.5s for data recomputation and re-render...');
  await new Promise(r => setTimeout(r, 3500));
  await cdp.screenshot('c:/Desktop/CODES/OrbitMesh/backend/scratch/cesium_after_refresh_now.png');
  console.log('Screenshot saved!');
  cdp.close();
}

main().catch(console.error);

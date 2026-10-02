const { CDP, getWsUrl } = require('./cdp-client');

async function main() {
  const ws = await getWsUrl();
  const cdp = new CDP(ws);
  await cdp.connect();
  console.log('Clicking "Run Scheduler Preview" button...');
  await cdp.eval(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent && b.textContent.includes('Run Scheduler Preview'));
      if (btn) btn.click();
    })()
  `);
  console.log('Waiting 3.5s for preview proposal to compute and overlay to appear...');
  await new Promise(r => setTimeout(r, 3500));
  await cdp.screenshot('c:/Desktop/CODES/OrbitMesh/backend/scratch/preview_overlay_verified.png');
  console.log('Screenshot saved to backend/scratch/preview_overlay_verified.png');
  cdp.close();
}

main().catch(console.error);

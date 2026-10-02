const { CDP, getWsUrl } = require('./cdp-client');

async function main() {
  const ws = await getWsUrl();
  console.log('Connecting to browser WebSocket:', ws);
  const cdp = new CDP(ws);
  await cdp.connect();

  console.log('Navigating to http://localhost:5173/ and performing hard refresh...');
  await cdp.navigate('http://localhost:5173/');
  await new Promise(r => setTimeout(r, 1000));
  await cdp.reload(true);
  
  // Wait up to 5s for the form to appear
  console.log('Waiting for login form...');
  let found = false;
  for (let i = 0; i < 20; i++) {
    found = await cdp.eval(`!!document.querySelector('button[type="submit"]')`);
    if (found) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (found) {
    console.log('Filling in operator@orbitmesh.com / operator123...');
    await cdp.eval(`
      (() => {
        const emailInput = document.querySelector('input[type="email"]');
        const passInput = document.querySelector('input[type="password"]');
        const submitBtn = document.querySelector('button[type="submit"]');

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(emailInput, 'operator@orbitmesh.com');
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));

        nativeSetter.call(passInput, 'operator123');
        passInput.dispatchEvent(new Event('input', { bubbles: true }));

        submitBtn.click();
      })()
    `);
    
    // Wait for login and dashboard to load
    console.log('Waiting for dashboard / authenticated state...');
    for (let i = 0; i < 20; i++) {
      const hasSidebar = await cdp.eval(`Array.from(document.querySelectorAll('button, div, span')).some(e => e.textContent && e.textContent.includes('Dashboard'))`);
      if (hasSidebar) {
        console.log('Dashboard detected after', (i+1)*250, 'ms');
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // Navigate to Orbital Network tab
  console.log('Navigating to Orbital Network tab...');
  const clicked = await cdp.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll('button, div, a, span'));
      const target = items.find(el => el.textContent && el.textContent.trim() === 'Orbital Network');
      if (target) {
        target.click();
        return true;
      }
      return false;
    })()
  `);
  console.log('Clicked Orbital Network tab:', clicked);

  console.log('Waiting 6s for Cesium WebGL scene and CartoDB tiles to load...');
  await new Promise(r => setTimeout(r, 6000));

  // Inspect Cesium DOM canvas & WebGL
  const canvasInfo = await cdp.eval(`
    (() => {
      const canvas = document.querySelector('canvas');
      const errorDiv = document.querySelector('.fade-in div[style*="background: rgba(239, 68, 68"]');
      return {
        canvasFound: !!canvas,
        canvasWidth: canvas ? canvas.width : 0,
        canvasHeight: canvas ? canvas.height : 0,
        visible: canvas ? (canvas.offsetWidth > 0 && canvas.offsetHeight > 0) : false,
        error: errorDiv ? errorDiv.innerText : null
      };
    })()
  `);
  console.log('Cesium canvas info:', canvasInfo);

  // Take screenshot of the globe
  const screenshotPath = 'c:/Desktop/CODES/OrbitMesh/backend/scratch/cesium_globe_verified.png';
  await cdp.screenshot(screenshotPath);
  console.log('Saved screenshot to:', screenshotPath);

  cdp.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

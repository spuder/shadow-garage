const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";

interface UADataBrand {
  brand: string;
}

// Only desktop/Android Chrome and Edge are supported. Chromium forks like Brave/Opera
// and iOS "Chrome" (which is really WebKit) are treated as unsupported.
export function isSupportedBrowser(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { brands: UADataBrand[] } }).userAgentData;
  if (uaData?.brands?.length) {
    return uaData.brands.some((b) => b.brand === "Google Chrome" || b.brand === "Microsoft Edge");
  }
  const ua = navigator.userAgent;
  if (/OPR\/|Brave|SamsungBrowser|Vivaldi|YaBrowser|CriOS|EdgiOS/.test(ua)) return false;
  return /Edg\//.test(ua) || /Chrome\//.test(ua);
}

export function showUnsupportedBrowserAlert(): void {
  const overlay = document.createElement("div");
  overlay.className = "browser-alert-overlay";
  overlay.innerHTML = `
    <div class="browser-alert" role="alertdialog" aria-modal="true" aria-labelledby="browserAlertTitle" aria-describedby="browserAlertBody">
      <div class="browser-alert-icon" aria-hidden="true">&#9888;</div>
      <h2 id="browserAlertTitle">Unsupported browser</h2>
      <p id="browserAlertBody">
        Shadow Garage only supports <strong>Google Chrome</strong> and <strong>Microsoft Edge</strong>.
        Other browsers don't have the WebUSB and Web Bluetooth support needed to talk to your cutting machine.
      </p>
      <div class="browser-alert-actions">
        <a class="btn-primary" href="${CHROME_DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">Download Chrome</a>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLElement>(".btn-primary")!.focus();
}

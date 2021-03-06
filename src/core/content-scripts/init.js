import { getBrowser } from 'toolkit/core/common/web-extensions';
import { ToolkitStorage } from 'toolkit/core/common/storage';
import { getUserSettings } from 'toolkit/core/settings';
import { getEnvironment } from 'toolkit/core/common/web-extensions';

const storage = new ToolkitStorage();

function sendToolkitBootstrap(options) {
  const browser = getBrowser();
  const environment = getEnvironment();
  const manifest = browser.runtime.getManifest();

  window.postMessage(
    {
      type: 'ynab-toolkit-bootstrap',
      ynabToolKit: {
        assets: {
          logo: browser.runtime.getURL('assets/images/logos/toolkitforynab-logo-200.png'),
        },
        environment,
        extensionId: browser.runtime.id,
        name: manifest.name,
        options,
        version: manifest.version,
      },
    },
    '*'
  );
}

function messageHandler(event) {
  if (event.data && event.data.type) {
    switch (event.data.type) {
      case 'ynab-toolkit-loaded':
        initializeYNABToolkit();
        break;
      case 'ynab-toolkit-error':
        handleToolkitError(event.data.context);
        break;
    }
  }
}

function handleToolkitError(context) {
  getBrowser().runtime.sendMessage({ type: 'error', context });
}

async function initializeYNABToolkit() {
  const userSettings = await getUserSettings();
  sendToolkitBootstrap(userSettings);
}

async function init() {
  const isToolkitDisabled = await storage.getFeatureSetting('DisableToolkit');
  if (isToolkitDisabled) {
    console.log(`${getBrowser().runtime.getManifest().name} is disabled!`);
    return;
  }

  // Load the toolkit bundle onto the YNAB dom
  const script = document.createElement('script');
  script.setAttribute('type', 'text/javascript');
  script.setAttribute('src', getBrowser().runtime.getURL('web-accessibles/ynab-toolkit.js'));
  document.getElementsByTagName('head')[0].appendChild(script);

  // wait for the bundle to tell us it's loaded
  window.addEventListener('message', messageHandler);
}

init();

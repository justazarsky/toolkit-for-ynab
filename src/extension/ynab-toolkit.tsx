import * as React from 'react';
import { features } from 'toolkit/extension/features';
import * as ynabUtils from 'toolkit/extension/utils/ynab';
import * as emberUtils from 'toolkit/extension/utils/ember';
import * as Collections from 'toolkit/extension/utils/collections';
import { isFeatureEnabled } from 'toolkit/extension/utils/feature';
import { getToolkitStorageKey, setToolkitStorageKey } from 'toolkit/extension/utils/toolkit';
import { logToolkitError, withToolkitError } from 'toolkit/core/common/errors/with-toolkit-error';
import { forEachRenderedComponent } from './utils/ember';
import { compareSemanticVersion } from './utils/helpers';
import { componentAppend } from './utils/react';
import { ToolkitReleaseModal } from 'toolkit/core/components/toolkit-release-modal';
import { Feature } from './features/feature';

export const TOOLKIT_LOADED_MESSAGE = 'ynab-toolkit-loaded';
export const TOOLKIT_BOOTSTRAP_MESSAGE = 'ynab-toolkit-bootstrap';

type SupportedEmberHook = 'didRender' | 'didInsertElement' | 'didUpdate';

export const EMBER_COMPONENT_TOOLKIT_HOOKS: SupportedEmberHook[] = ['didRender', 'didInsertElement', 'didUpdate'];
export const emberComponentToolkitHookKey = (hookName: SupportedEmberHook): `_tk_${SupportedEmberHook}_hooks_` => `_tk_${hookName}_hooks_`;

window.__toolkitUtils = {
  ...ynabUtils,
  ...emberUtils,
  ...Collections,
};

interface ToolkitEmberHook {
  context: Feature;
  fn(element: Element): void;
}

type ToolkitEnabledComponent = Ember['Component'] & {
  element?: Element;
  _tk_didRender_hooks_?: ToolkitEmberHook[]
  _tk_didInsertElement_hooks_?: ToolkitEmberHook[];
  _tk_didUpdate_hooks_?: ToolkitEmberHook[];
}

export class YNABToolkit {
  _featureInstances: Feature[] = [];

  initializeToolkit() {
    window.addEventListener('message', this._onBackgroundMessage);
    window.postMessage({ type: TOOLKIT_LOADED_MESSAGE }, '*');
  }

  _applyGlobalCSS() {
    const globalCSS = this._featureInstances.reduce((css, feature) => {
      const wrappedInjectCSS = withToolkitError(feature.injectCSS.bind(feature), feature);
      const featureCSS = wrappedInjectCSS();

      if (isFeatureEnabled(feature.settings.enabled) && featureCSS) {
        css += `/* == Injected CSS from feature: ${feature.constructor.name} == */\n${featureCSS}\n\n`;
      }

      return css;
    }, require('./ynab-toolkit.css'));

    $('head').append(
      $('<style>', { id: 'toolkit-injected-styles', type: 'text/css' }).text(globalCSS)
    );
  }

  _createFeatureInstances() {
    features.forEach((Feature) => {
      this._featureInstances.push(new Feature());
    });
  }

  _invokeFeature = (featureName: FeatureName) => {
    const feature = this._featureInstances.find((f) => f.constructor.name === featureName);
    const wrappedShouldInvoke = feature.shouldInvoke.bind(feature);
    const wrappedInvoke = feature.invoke.bind(feature);
    if (isFeatureEnabled(feature.settings.enabled) && wrappedShouldInvoke()) {
      wrappedInvoke();
    }
  };

  _invokeFeatureInstances = async () => {
    this._featureInstances.forEach(async (feature) => {
      if (isFeatureEnabled(feature.settings.enabled)) {
        feature.applyListeners();

        try {
          await feature.willInvoke();
        } catch (exception) {
          const featureName = feature.constructor.name as FeatureName;
          const featureSetting = window.ynabToolKit.options[featureName];
          logToolkitError({
            exception,
            featureName,
            featureSetting,
            functionName: 'willInvoke',
          });
        }

        const wrappedShouldInvoke = withToolkitError(feature.shouldInvoke.bind(feature), feature);
        const wrappedInvoke = withToolkitError(feature.invoke.bind(feature), feature);
        if (wrappedShouldInvoke()) {
          wrappedInvoke();
        }
      }
    });
  };

  _onBackgroundMessage = (event: MessageEvent) => {
    if (event.source === window && event.data.type === TOOLKIT_BOOTSTRAP_MESSAGE) {
      window.ynabToolKit = {
        ...window.ynabToolKit,
        ...event.data.ynabToolKit,
        hookedComponents: new Set(),
      };

      this._setupErrorTracking();
      this._createFeatureInstances();
      this._removeMessageListener();
      this._waitForUserSettings();
    }
  };

  _removeMessageListener() {
    window.removeEventListener('message', this._onBackgroundMessage);
  }

  _setupErrorTracking = () => {
    window.addEventListener('error', ({ error }) => {
      let serializedError = '';
      if (error.message && error.stack) {
        serializedError = `${error.message}\n${error.stack.toString()}`;
      } else if (error.message) {
        serializedError = error.message;
      }

      if (serializedError.includes(window.ynabToolKit.extensionId)) {
        logToolkitError({
          exception: error,
          featureName: 'unknown',
          featureSetting: 'unknown',
          functionName: 'global',
        });
      }
    });
  };

  _addToolkitEmberHooks = () => {
    EMBER_COMPONENT_TOOLKIT_HOOKS.forEach((lifecycleName) => {
      Ember.Component.prototype[lifecycleName] = function () {
        const self = this as ToolkitEnabledComponent;
        const hooks = self[emberComponentToolkitHookKey(lifecycleName)];
        if (hooks) {
          hooks.forEach(({ context, fn }) => fn.call(context, self.element));
        }
      };
    });
  };

  _invokeAllHooks = () => {
    window.ynabToolKit.hookedComponents.forEach((key) => {
      forEachRenderedComponent(key, (view: ToolkitEnabledComponent) => {
        EMBER_COMPONENT_TOOLKIT_HOOKS.forEach((lifecycleName) => {
          const hooks = view[emberComponentToolkitHookKey(lifecycleName)];
          if (hooks) {
            hooks.forEach((hook) => hook.fn.call(hook.context, view.element));
          }
        });
      });
    });
  };

  _showNewReleaseModal = () => {
    componentAppend(
      <div id="tk-modal-container">
        <ToolkitReleaseModal
          onClose={() => document.querySelector('#tk-modal-container').remove()}
        />
      </div>,
      document.querySelector('.layout')
    );
  };

  _checkReleaseVersion = () => {
    const latestVersionKey = `latest-version-${ynabToolKit.environment}`;
    let latestVersion = getToolkitStorageKey(latestVersionKey);
    if (!latestVersion) {
      setToolkitStorageKey(latestVersionKey, ynabToolKit.version);
      return;
    }

    if (compareSemanticVersion(latestVersion, ynabToolKit.version) === -1) {
      setToolkitStorageKey(latestVersionKey, ynabToolKit.version);
      this._showNewReleaseModal();
    }
  };

  _waitForUserSettings() {
    const self = this;

    (function poll() {
      if (ynabUtils.isYNABReady()) {
        // add a global invokeFeature to the global ynabToolKit for legacy features
        // once legacy features have been removed, this should be a global exported function
        // from this file that features can require and use
        ynabToolKit.invokeFeature = self._invokeFeature;

        // inject the global css from each feature into the HEAD of the DOM
        self._applyGlobalCSS();

        self._addToolkitEmberHooks();

        self._checkReleaseVersion();

        // Hook up listeners and then invoke any features that are ready to go.
        self._invokeFeatureInstances();

        Ember.run.later(self._invokeAllHooks, 100);
      } else if (typeof Ember !== 'undefined') {
        Ember.run.later(poll, 250);
      } else {
        setTimeout(poll, 250);
      }
    })();
  }
}

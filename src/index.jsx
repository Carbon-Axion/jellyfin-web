// Import legacy browser polyfills
import 'lib/legacy';

import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// NOTE: We need to import this first to initialize the connection
import ServerConnections from './components/ServerConnections';

import { appHost } from './components/apphost';
import autoFocuser from './components/autoFocuser';
import packageManager from './components/packageManager';
import { pluginManager } from './components/pluginManager';
import { appRouter } from './components/router/appRouter';
import globalize from './lib/globalize';
import { loadCoreDictionary } from 'lib/globalize/loader';
import { initialize as initializeAutoCast } from 'scripts/autocast';
import browser from './scripts/browser';
import keyboardNavigation from './scripts/keyboardNavigation';
import { currentSettings } from './scripts/settings/userSettings';
import { getPlugins } from './scripts/settings/webSettings';
import taskButton from './scripts/taskbutton';
import { pageClassOn, serverAddress } from './utils/dashboard';
import Events from './utils/events';

import RootApp from './RootApp';
import { history } from 'RootAppRouter';

// Import the button webcomponent for use throughout the site
// NOTE: This is a bit of a hack, files should ensure the component is imported before use
import './elements/emby-button/emby-button';

// Import auto-running components
// NOTE: This is an anti-pattern
import './components/playback/displayMirrorManager';
import './components/playback/playerSelectionMenu';
import './components/themeMediaPlayer';
import './scripts/autoThemes';
import './scripts/mouseManager';
import './scripts/screensavermanager';
import './scripts/serverNotifications';

// Import site styles
import './styles/site.scss';
import './styles/livetv.scss';
import './styles/dashboard.scss';
import './styles/detailtable.scss';
import './styles/librarybrowser.scss';

function init() {
    // Log current version to console to help out with issue triage and debugging
    console.info(
        `[${__PACKAGE_JSON_NAME__}]
version: ${__PACKAGE_JSON_VERSION__}
commit: ${__COMMIT_SHA__}
build: ${__JF_BUILD_VERSION__}`);

    // This is used in plugins
    window.Events = Events;
    window.TaskButton = taskButton;

    serverAddress().then(server => {
        if (server) {
            ServerConnections.initApiClient(server);
        }
    }).then(() => {
        console.debug('initAfterDependencies promises resolved');

        initializeAutoCast(ServerConnections.currentApiClient());

        loadCoreDictionary().then(function () {
            onGlobalizeInit();
        });

        keyboardNavigation.enable();
        autoFocuser.enable();

        Events.on(ServerConnections, 'localusersignedin', globalize.updateCurrentCulture);
        Events.on(ServerConnections, 'localusersignedout', globalize.updateCurrentCulture);
    });
}

function onGlobalizeInit() {
    if (window.appMode === 'android'
        && window.location.href.toString().toLowerCase().indexOf('start=backgroundsync') !== -1
    ) {
        return onAppReady();
    }

    document.title = globalize.translateHtml(document.title, 'core');

    if (browser.tv && !browser.android) {
        console.debug('using system fonts with explicit sizes');
        import('./styles/fonts.sized.scss');
    } else if (__USE_SYSTEM_FONTS__) {
        console.debug('using system fonts');
        import('./styles/fonts.scss');
    } else {
        console.debug('using default fonts');
        import('./styles/fonts.scss');
        import('./styles/fonts.noto.scss');
    }

    loadPlugins().then(onAppReady);
}

function loadPlugins() {
    console.groupCollapsed('loading installed plugins');
    console.dir(pluginManager);
    return getPlugins().then(function (list) {
        if (!appHost.supports('remotecontrol')) {
            // Disable remote player plugins if not supported
            list = list.filter(plugin => !plugin.startsWith('sessionPlayer')
                && !plugin.startsWith('chromecastPlayer'));
        } else if (!browser.chrome && !browser.edgeChromium && !browser.opera) {
            // Disable chromecast player in unsupported browsers
            list = list.filter(plugin => !plugin.startsWith('chromecastPlayer'));
        }

        // add any native plugins
        if (window.NativeShell) {
            list = list.concat(window.NativeShell.getPlugins());
        }

        Promise.all(list.map(plugin => pluginManager.loadPlugin(plugin)))
            .then(() => console.debug('finished loading plugins'))
            .catch(e => console.warn('failed loading plugins', e))
            .finally(() => {
                console.groupEnd('loading installed plugins');
                packageManager.init();
            })
        ;
    });
}

async function onAppReady() {
    console.debug('begin onAppReady');

    console.debug('onAppReady: loading dependencies');

    if (browser.iOS) {
        import('./styles/ios.scss');
    }

    Events.on(appHost, 'resume', () => {
        ServerConnections.currentApiClient()?.ensureWebSocket();
    });

    const container = document.getElementById('reactRoot');
    // Remove the splash logo
    container.innerHTML = '';

    await appRouter.start();

    const root = createRoot(container);
    root.render(
        <StrictMode>
            <RootApp history={history} />
        </StrictMode>
    );

    if (!browser.tv && !browser.xboxOne && !browser.ps4) {
        import('./components/nowPlayingBar/nowPlayingBar');
    }

    if (appHost.supports('remotecontrol')) {
        import('./components/playback/playerSelectionMenu');
        import('./components/playback/remotecontrolautoplay');
    }

    if (!appHost.supports('physicalvolumecontrol') || browser.touch) {
        import('./components/playback/volumeosd');
    }

    /* eslint-disable-next-line compat/compat */
    if (navigator.mediaSession || window.NativeShell) {
        import('./components/playback/mediasession');
    }

    if (!browser.tv && !browser.xboxOne) {
        import('./components/playback/playbackorientation');
        registerServiceWorker();

        if (window.Notification) {
            import('./components/notifications/notifications');
        }
    }

    // Apply custom CSS
    const apiClient = ServerConnections.currentApiClient();
    if (apiClient) {
        const brandingCss = fetch(apiClient.getUrl('Branding/Css'))
            .then(function(response) {
                if (!response.ok) {
                    throw new Error(response.status + ' ' + response.statusText);
                }
                return response.text();
            })
            .catch(function(err) {
                console.warn('Error applying custom css', err);
            });

        const handleStyleChange = async () => {
            let style = document.querySelector('#cssBranding');
            if (!style) {
                // Inject the branding css as a dom element in body so it will take
                // precedence over other stylesheets
                style = document.createElement('style');
                style.id = 'cssBranding';
                document.body.appendChild(style);
            }

            const css = [];
            // Only add branding CSS when enabled
            if (!currentSettings.disableCustomCss()) css.push(await brandingCss);
            // Always add user CSS
            css.push(currentSettings.customCss());

            style.textContent = css.join('\n');
        };

        Events.on(ServerConnections, 'localusersignedin', handleStyleChange);
        Events.on(ServerConnections, 'localusersignedout', handleStyleChange);
        Events.on(currentSettings, 'change', (e, prop) => {
            if (prop == 'disableCustomCss' || prop == 'customCss') {
                handleStyleChange();
            }
        });

        handleStyleChange();
    }
}

function registerServiceWorker() {
    /* eslint-disable compat/compat */
    if (navigator.serviceWorker && window.appMode !== 'cordova' && window.appMode !== 'android') {
        navigator.serviceWorker.register('serviceworker.js').then(() =>
            console.log('serviceWorker registered')
        ).catch(error =>
            console.log('error registering serviceWorker: ' + error)
        );
    } else {
        console.warn('serviceWorker unsupported');
    }
    /* eslint-enable compat/compat */
}

init();

pageClassOn('viewshow', 'standalonePage', function () {
    document.querySelector('.skinHeader').classList.add('noHeaderRight');
});

pageClassOn('viewhide', 'standalonePage', function () {
    document.querySelector('.skinHeader').classList.remove('noHeaderRight');
});

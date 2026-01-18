async function getCredentials() {
    const credentials = await browser.storage.local.get(['apiScheme', 'apiHost', 'apiPort', 'apiUsername', 'apiPassword']);
    return {
      username: credentials.apiUsername,
      password: credentials.apiPassword,
      url: `${credentials.apiScheme}://${credentials.apiHost}:${credentials.apiPort}`,
      credentials: credentials
    };
}

async function login() {
    const { username, password, url } = await getCredentials();
    const response = await fetch(`${url}/api/v2/auth/login`, {
      method: "POST",
      body: new URLSearchParams({username, password})
    });
    return response.text();
}

async function addTorrent(urls, credentials, category = null) {
    const { url } = credentials;
    const params = { urls };
    if (category) {
      params.category = category;
    }
    const response = await fetch(`${url}/api/v2/torrents/add`, {
        method: "POST",
        body: new URLSearchParams(params),
    });
    if (response.status === 200) {
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs.length === 0) return;
        browser.tabs.sendMessage(tabs[0].id, {
          action: "torrentAdded"
        });
      });
    }
}

async function getCategories() {
    const { url } = await getCredentials();
    await login();
    const response = await fetch(`${url}/api/v2/torrents/categories`);
    if (response.status === 200) {
      return await response.json();
    }
    return {};
}

async function createCategory(categoryName, savePath = '') {
    const { url } = await getCredentials();
    await login();
    const response = await fetch(`${url}/api/v2/torrents/createCategory`, {
        method: "POST",
        body: new URLSearchParams({ category: categoryName, savePath }),
    });
    return response.status === 200;
}

async function openQbit() {
  const { url } = await getCredentials();
  const newTab = await browser.tabs.create({ url: url });
  return newTab.id;
}

async function regularLogin(tabId) {
  const { username, password } = await getCredentials();
  await browser.tabs.executeScript(tabId, {
    code: `
      if (document.getElementById('loginform')) {
        document.getElementById('username').value = '${username}';
        document.getElementById('password').value = '${password}';
        document.getElementById('loginButton').click();
      }
    `
    });
}

async function createContextMenu() {
  await browser.contextMenus.removeAll();
  const { defaultCategory } = await browser.storage.local.get('defaultCategory');
  const categoryLabel = defaultCategory ? ` [${defaultCategory}]` : '';

  browser.contextMenus.create({
    id: "sendToQbit",
    title: `Send to qBittorrent${categoryLabel}`,
    contexts: ["link"],
  });
  browser.contextMenus.create({
    id: "sendToQbitWithCategory",
    title: "Send to qBittorrent (choose category...)",
    contexts: ["link"],
  });
}

async function updateContextMenuTitle() {
  const { defaultCategory } = await browser.storage.local.get('defaultCategory');
  const categoryLabel = defaultCategory ? ` [${defaultCategory}]` : '';
  browser.contextMenus.update("sendToQbit", {
    title: `Send to qBittorrent${categoryLabel}`
  });
}

browser.runtime.onStartup.addListener(() => {
  createContextMenu();
});

browser.runtime.onInstalled.addListener(() => {
  createContextMenu();
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "sendToQbit") {
    const credentials = await getCredentials();
    await login();
    const { defaultCategory } = await browser.storage.local.get('defaultCategory');
    addTorrent(info.linkUrl, credentials, defaultCategory || null);
  } else if (info.menuItemId === "sendToQbitWithCategory") {
    await browser.storage.local.set({ pendingTorrentUrl: info.linkUrl });
    browser.windows.create({
      url: browser.runtime.getURL("category-picker.html"),
      type: "popup",
      width: 380,
      height: 300
    });
  }
});

browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && changes.magnetLink) {
    const credentials = await getCredentials();
    await login();
    const { defaultCategory } = await browser.storage.local.get('defaultCategory');
    addTorrent(changes.magnetLink.newValue, credentials, defaultCategory || null);
  }
  if (areaName === "local" && changes.defaultCategory) {
    updateContextMenuTitle();
  }
});

let loginTabs = new Set();
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action === 'disableCSRF') {
    const tabId = await openQbit();
    await regularLogin();
    loginTabs.add(tabId);
  }
  if (message.action === "openQbit") {
    const response = await login();
    const tabId = await openQbit();
    if (response !== 'Ok.') {
      await regularLogin(tabId)
    }
  }
  if (message.action === "getCategories") {
    return getCategories();
  }
  if (message.action === "createCategory") {
    return createCategory(message.categoryName, message.savePath || '');
  }
  if (message.action === "addTorrentWithCategory") {
    const credentials = await getCredentials();
    await login();
    addTorrent(message.url, credentials, message.category || null);
    return true;
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && loginTabs.has(tabId)) {
    setTimeout(() => {
      browser.tabs.executeScript(tabId, {
        code: `
          if (document.getElementById('preferencesButton')) {
            document.getElementById('preferencesButton').click();
            setTimeout(() => {document.getElementById('PrefWebUILink').click();}, 500);
            setTimeout(() => {if (document.getElementById('csrf_protection_checkbox').checked) {document.getElementById('csrf_protection_checkbox').click();}}, 500);
            setTimeout(() => {document.querySelector('input[type="button"][value="Save"]').click();}, 500);
          }
        `
      });
    }, 500);
    loginTabs.delete(tabId);
  }
});

let offscreenCreating;
let debugTarget = null; // To keep track of the attached tab

// Generic RPC handler for chrome.* APIs
async function handleRpc(message, sender, sendResponse) {
  if (message.source !== 'crush-rpc') return false;

  const { action, args } = message;
  const path = action.split('.');
  
  let obj = chrome;
  for (let i = 0; i < path.length - 1; i++) {
    obj = obj[path[i]];
    if (obj === undefined) {
      sendResponse({ error: `Invalid RPC path: ${action}` });
      return;
    }
  }

  const fn = obj[path[path.length - 1]];
  if (typeof fn !== 'function') {
    sendResponse({ error: `RPC function not found: ${action}` });
    return;
  }

  let finalArgs = [...args];

  // Special handling for the debugger API to manage the debugTarget state
  if (action === 'debugger.attach') {
    if (debugTarget) {
      // Prevent attaching to a new target if already attached.
      // The client should detach first.
      sendResponse({ error: `Already attached to tab ${debugTarget.tabId}. Detach first.` });
      return;
    }
    const target = args[0];
    if (!target || (!target.tabId && !target.extensionId && !target.targetId)) {
        sendResponse({ error: 'Attach requires a valid target.' });
        return;
    }
    debugTarget = target;
  } else if (action === 'debugger.detach') {
    if (args.length === 0) {
      if (!debugTarget) {
        sendResponse({ error: 'Not attached to any target.' });
        return;
      }
      finalArgs = [debugTarget];
    }
  } else if (action === 'debugger.sendCommand') {
     if (!debugTarget) {
        sendResponse({ error: 'Not attached to any target.' });
        return;
      }
      finalArgs.unshift(debugTarget);
  }

  try {
    const result = await fn.apply(obj, finalArgs);
    
    // If detach was successful, clear the state
    if (action === 'debugger.detach') {
        const detachedTarget = finalArgs[0];
        if (debugTarget && detachedTarget.tabId === debugTarget.tabId) {
            debugTarget = null;
        }
    }

    sendResponse({ result });
  } catch (e) {
    sendResponse({ error: e.message });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source === 'crush-rpc') {
    handleRpc(message, sender, sendResponse);
    return true; // Indicates we will respond asynchronously
  }

  if (message.target === 'service-worker') {
    if (message.type === 'start-offscreen') {
      setupOffscreenDocument('offscreen.html');
    } else if (message.type === 'stop-offscreen') {
      closeOffscreenDocument('offscreen.html');
    }
    return false; // Fire-and-forget
  }

  return false;
});


// Forward debugger events to the side panel
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Only forward events from the tab we are attached to
  if (debugTarget && source.tabId === debugTarget.tabId) {
      chrome.runtime.sendMessage({
        target: 'sidepanel',
        type: 'cdp-event',
        method,
        params,
      }).catch(e => console.log("Sidepanel not available to receive cdp-event"));
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (debugTarget && source.tabId === debugTarget.tabId) {
    debugTarget = null;
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      type: 'cdp-detach',
      reason,
    }).catch(e => console.log("Sidepanel not available to receive cdp-detach"));
  }
});


// --- Offscreen Document Helpers ---
// (These are unchanged)

async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)],
  });

  if (existingContexts.length > 0) return;
  if (offscreenCreating) await offscreenCreating;
  
  offscreenCreating = chrome.offscreen.createDocument({
    url: path,
    reasons: ['BLANK_CANVAS'],
    justification: 'To run background tasks.',
  });
  await offscreenCreating;
  offscreenCreating = null;
}

async function closeOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)],
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

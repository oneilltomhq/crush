// offscreen.js

let counterInterval;
let counter = 0;

function startCounter() {
  if (counterInterval) {
    return;
  }
  counterInterval = setInterval(() => {
    counter++;
    chrome.runtime.sendMessage({
      target: 'side-panel',
      type: 'counter-update',
      value: counter,
    });
  }, 1000);
}

function stopCounter() {
  if (counterInterval) {
    clearInterval(counterInterval);
    counterInterval = null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen-document') {
    return;
  }

  switch (message.type) {
    case 'start-counter':
      startCounter();
      break;
    case 'stop-counter':
      stopCounter();
      break;
    case 'get-counter':
      chrome.runtime.sendMessage({
        target: 'side-panel',
        type: 'counter-update',
        value: counter,
      });
      break;
  }
});

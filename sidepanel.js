// sidepanel.js
const counterValueSpan = document.getElementById('counter-value');
const startCounterButton = document.getElementById('start-counter');
const stopCounterButton = document.getElementById('stop-counter');

startCounterButton.addEventListener('click', async () => {
  // Ensure the offscreen document is running
  await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'start-offscreen'
  });
  // Then tell it to start the counter
  await chrome.runtime.sendMessage({
    target: 'offscreen-document',
    type: 'start-counter'
  });
});

stopCounterButton.addEventListener('click', async () => {
  // Tell the offscreen document to stop
  await chrome.runtime.sendMessage({
    target: 'offscreen-document',
    type: 'stop-counter'
  });
  // Now we can safely close the offscreen document
  // This is optional, you might want to keep it alive
  // await chrome.runtime.sendMessage({
  //   target: 'service-worker',
  //   type: 'stop-offscreen'
  // });
});

// Listen for counter updates from the offscreen document
chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'side-panel' && message.type === 'counter-update') {
    counterValueSpan.textContent = message.value;
  }
});

// When the side panel opens, ask the offscreen document for the current count
function getInitialCounterValue() {
    chrome.runtime.sendMessage({
        target: 'offscreen-document',
        type: 'get-counter'
    });
}

getInitialCounterValue();

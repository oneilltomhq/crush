// src/chrome-rpc.ts

/**
 * A client for invoking privileged Chrome extension APIs that are only available
 * in the service worker context.
 *
 * This function sends a message to the service worker and returns a promise
 * that resolves with the response.
 *
 * @param action The name of the action to perform (e.g., 'debugger.attach').
 * @param args The arguments for the action.
 * @returns A promise that resolves with the result from the service worker.
 */
export async function rpc(action: string, ...args: any[]): Promise<any> {
    try {
        const response = await chrome.runtime.sendMessage({
            source: 'crush-rpc',
            action,
            args,
        });

        if (response?.error) {
            // Re-throw the error from the service worker in the client context
            throw new Error(response.error);
        }

        return response?.result;

    } catch (error) {
        // This could happen if the extension context is invalidated (e.g., reloaded)
        // or if the service worker has an unhandled exception.
        console.error(`RPC call '${action}' failed:`, error);
        throw error;
    }
}

// Example usage (for documentation purposes):
//
// import { rpc } from './chrome-rpc';
//
// async function attachToCurrentTab() {
//   try {
//     const tabs = await rpc('tabs.query', { active: true, currentWindow: true });
//     if (tabs && tabs.length > 0) {
//       const tabId = tabs[0].id;
//       await rpc('debugger.attach', { tabId }, '1.3');
//       console.log('Attached to tab', tabId);
//     }
//   } catch (e) {
//     console.error('Failed to attach:', e.message);
//   }
// }

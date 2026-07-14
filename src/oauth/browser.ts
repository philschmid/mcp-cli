/**
 * Browser utilities for OAuth
 */

import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { debug } from '../config.js';

/**
 * Open URL in default browser (cross-platform)
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();
    let command: string;

    switch (os) {
      case 'darwin':
        command = `open "${url}"`;
        break;
      case 'win32':
        command = `start "" "${url}"`;
        break;
      default:
        // Linux and others
        command = `xdg-open "${url}"`;
    }

    debug(`Opening browser: ${command}`);

    exec(command, (error) => {
      if (error) {
        console.error(`Failed to open browser: ${error.message}`);
        console.error(`Please manually open: ${url}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

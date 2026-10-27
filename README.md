# SFTP Studio

A lightweight desktop client that combines an SFTP file browser, a built-in text editor and multi-tab SSH terminals in a single window. Built with Electron, [ssh2](https://github.com/mscdex/ssh2) and [xterm.js](https://xtermjs.org/).

## Features

- **SFTP file browser** – navigate remote directories, with folders listed first and hidden files dimmed. Type a path into the address bar to jump straight to it.
- **Built-in editor** – click a remote file to open it, edit it and save it back to the server with `Ctrl+S`. `Esc` closes the editor.
- **Multi-tab SSH terminal** – open as many interactive shell sessions as you need over a single connection. Terminals use full xterm-256color emulation and resize with the window.
- **Clipboard support** – `Ctrl+C` copies a selection (or `Ctrl+Shift+C`), `Ctrl+V` or right-click pastes.
- **Resizable layout** – drag the divider between the file browser and the terminal to suit your workflow.
- **Keep-alive** – the connection sends keep-alive packets every 15 seconds, and the app returns to the login screen if the connection drops.
- **Portable Windows build** – package the app as a single `.exe` that needs no installer.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- A remote server that accepts SSH password authentication on port 22 with the SFTP subsystem enabled

## Getting started

```bash
git clone https://github.com/code-dev-env/sftp-ssh-studio.git
cd sftp-ssh-studio
npm install
npm start
```

Enter the host, username and password on the login screen and click **Connect**.

## Building

Create a portable Windows executable:

```bash
npm run build
```

The output is written to the `dist/` folder as `SFTPStudio.exe`.

## Usage

| Action | How |
| --- | --- |
| Open a folder | Click it in the file list |
| Go up a level | Click `..` |
| Jump to a path | Type it in the address bar and press `Enter` |
| Edit a file | Click it, then `Ctrl+S` to save |
| New terminal | Click `+` in the tab bar |
| Close a terminal | Click `✕` on its tab (closing the last tab disconnects) |
| Copy / paste in terminal | `Ctrl+C` with a selection / `Ctrl+V` or right-click |

## Project structure

```
├── main.js        Electron main process: SSH/SFTP connection and IPC handlers
├── renderer.js    UI logic: login, file browser, editor, terminal tabs
├── index.html     Application layout and styles
├── build/         Application icons
└── package.json   Dependencies and electron-builder configuration
```

## Security notes

- Only password authentication is currently supported; key-based authentication is not yet available.
- Host keys are not verified, so connections are not protected against man-in-the-middle attacks. Use SFTP Studio only on networks you trust.
- Credentials are held in memory for the session and are never written to disk.
- The renderer runs with Node integration enabled. Only use the app to connect to servers you trust.

## Roadmap

- SSH key authentication
- Host key verification
- File upload, download, rename and delete
- Configurable port and saved connection profiles

## License

Released under the terms of the [LICENSE](LICENSE) file included in this repository.

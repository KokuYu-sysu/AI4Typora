# typora-ai-edit Plugin

`typora-ai-edit / ai-edit (showing in Typora)` is a Typora Community Plugin for paper writing on Windows. It brings AI-assisted editing into Typora without modifying Typora's installation files.

This Windows port focuses on a stable writing workflow:

- rewrite selected text from the right-click menu
- rewrite selected text with full-document context
- ask writing questions with `Ctrl + E`
- support ChatGPT OAuth token files on Windows
- support OpenAI-compatible APIs
- If this plugin is useful, please give me a STAR ⭐ to support me! Thanks！

## Features

Included: 

- `AI Optimize (Selection Only)`
- `AI Optimize (Use Full Document Context)`
- `AI Q&A` via `Ctrl + E` (Support Image in Version 1.4.0)
- settings page inside Typora Community Plugins
- Select the model supported

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/Modelselect.png?raw=true)

- Windows OAuth token auto-detection
- OpenAI-compatible API mode
- Incremental response streaming for both ChatGPT OAuth and OpenAI-compatible providers
- Now the response window can be dragged (Version 1.2.0)

## Requirements

- Windows 11
- Typora
- [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin)
- Node.js `>= 22` is recommended for development

## Installation

### 1. Install Typora Community Plugin Framework

Make sure the community plugin framework is already installed and working.

A common runtime directory is:

```text
C:\Users\<YourUser>\.typora\community-plugins
```

The plugin should be placed in:

```text
C:\Users\<YourUser>\.typora\community-plugins\plugins\typora-plugin-ai-edit
```

### 2. Copy or clone this plugin folder

You can either copy the folder manually or clone it directly into the framework's `plugins` directory.

```powershell
cd C:\Users\<YourUser>\.typora\community-plugins\plugins
git clone https://github.com/KokuYu-sysu/typora-gpt-edit.git typora-plugin-ai-edit
```

If you prefer manual installation, copy the entire `typora-plugin-ai-edit` folder into the framework's `plugins` directory.

### 3. Restart Typora

After restarting Typora:

1. Press `Ctrl + .`
2. Open `Community Plugins`
3. Enable `AI Edit`

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/overview.png?raw=true)

## Configuration

Open `Ctrl + .` -> `Community Plugins` -> `AI Edit`.

### Provider 1: ChatGPT OAuth Login

This mode reads an existing OAuth token file from your local machine.

OR

Click `OAuth Login` and `Download user Info` to connect OpenAI and Typora.

Auto-detect order:

```text
%APPDATA%\oauth-cli-kit\auth\codex.json
%LOCALAPPDATA%\oauth-cli-kit\auth\codex.json
%USERPROFILE%\.codex\auth.json
```

You can also manually set `OAuth Token File Path` in the settings page.

### Provider 2: OpenAI Compatible

This mode uses:

- `Base URL`
- `API Key`
- `Model`

You can point it to OpenAI-compatible gateways or self-hosted backends. Version 1.3.0 supports an alternative approach that enables the use of other OpenAI-compatible AI models, such as DeepSeek, and requires an `api_key` and `base_url`.

Automatic failover is controlled by `Enable automatic fallback to backup API
connections`. Configure the optional `Backup API 1` and `Backup API 2` URL,
key, and model settings in this provider section.

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/AlterAPI.png?raw=true)

## Usage

### Rewrite selected text

1. Select text in the editor
2. Right-click
3. Choose one of:
   - `AI Optimize (Selection Only)`
   - `AI Optimize (Use Full Document Context)`

The plugin opens a Diff dialog that keeps the original selection visible while
the candidate is generated. Deleted text is shown with a strike-through and
new text is shown as an insertion. Unchanged context may be collapsed for
readability.

Responses are rendered incrementally as they arrive for both ChatGPT OAuth and
OpenAI-compatible providers. The result dialog shows the generated text while
it is being completed; its Copy action is available after generation completes,
after you stop generation, or after validation fails. If you stop generation,
or if context-rewrite formula validation fails, the partial/candidate text
remains available for copying but the `Replace` action is disabled.

![rightclick.png](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/rightclick.png?raw=true)

When generation completes, click `Replace` to apply the candidate in one step,
`Copy` to copy it, or `Regenerate` to request another candidate. Every
regeneration uses the original captured selection and instructions; it does
not rewrite the previous candidate. `Regenerate` keeps the same Diff window
open.

`Stop` leaves the partial response visible, but a stopped response can only be
copied, regenerated, or closed. It cannot be applied to the document. If the
selection or active file changes while a response is being generated, the
plugin rejects `Replace` and keeps the explanation in the Diff window. An
unsaved document must be saved before a selection can be replaced.

The Diff engine is implemented locally in JavaScript with no Python runtime,
Diff package, or network round trip. It handles Unicode text and keeps formula
spans intact as atomic units when they are part of the rewritten selection.

The Diff window keeps the candidate available until you replace, copy,
regenerate, or close it:
![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/854981fa4574014331d19f3da39d7ffeb7f8720e/asset/Revisement.png?raw=true)

### Ask writing questions

1. Focus the editor, with or without a text selection.
2. Press `Ctrl + E`, or select text and choose `AI Q&A` from the right-click menu.
3. Enter your question
4. Optionally type `YES` to include the full document as context

The answer can then be inserted into the document.

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/854981fa4574014331d19f3da39d7ffeb7f8720e/asset/AI_Q&A.png?raw=true)

### Ask Image

Right-click an image to use the separate image Q&A action:

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/Image.png?raw=true)

Then enter the question:

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/ImageQA.png?raw=true)

Output: you can insert the answer to your file or copy it.

![](https://github.com/KokuYu-sysu/typora-gpt-edit/blob/main/asset/ImageA.png?raw=true)

## Default behavior

- Right-click AI actions only appear when text is selected in the editor.
- Right-click actions on an image are available when the target is an image.
- `Ctrl + E` triggers Q&A whenever the editor target is focused, regardless of
  whether text is selected.
- The built-in default persona is a senior linguistics expert and professional
  editor, with attention to grammar, semantics, pragmatics, register,
  terminology consistency, and cross-language expression.
- Existing custom prompts remain preserved; changing the built-in defaults does
  not overwrite prompts that the user has already customized or imported.
- Chinese and English default prompts are chosen from the browser locale, and
  all prompts can be edited to suit your document and workflow.

### Context-aware rewrite and formulas

`AI Optimize (Use Full Document Context)` protects formulas in the selected
passage being rewritten, except formulas inside inline-code spans and fenced
code blocks, before sending the request. It recognizes `$...$`, `$$...$$`,
`\(...\)`, and `\[...\]`,
then restores the original formula text after generation. The full document is
provided as unchanged context; it is not itself transformed or protected for
replacement. The candidate is checked before replacement: every exact formula
placeholder must appear once and in its original order. Missing, duplicated,
mutated, or reordered placeholders disable `Replace` while leaving the
candidate visible and copyable.

When OpenAI-compatible failover is enabled, a failed connection's partial
stream is cleared before the next provider attempt is displayed, so outputs
from different attempts are never concatenated.

## Shortcut Key

| Shortcut Key       | Function                                     |
| ------------------ | -------------------------------------------- |
| `Ctrl + E`         | `AI Q&A` when the editor is focused         |
| `Ctrl + R`         | `AI Optimize (Selection Only)`               |
| `Ctrl + Shift + R` | `AI Optimize (Use Full Document Context)`    |
| `Ctrl + C`         | General streaming output window only: copy and close |
| `Ctrl + Enter`     | General streaming output window only: replace/insert |

The local-rewrite Diff window uses its visible Copy, Regenerate, Replace, and
Close buttons. Copy does not close that window; `Escape` closes it. `Ctrl + C`
and `Ctrl + Enter` do not trigger copy or replacement in the Diff window.

## Development notes

Main files:

- `main.js`
- `manifest.json`
- `src/plugin.js`
- `src/platform.js`
- `src/api.js`
- `src/settings-tab.js`
- `src/config.js`
- `src/ui.js`
- `src/editor.js`
- `test/api-failover.test.js`
- `test/api-preferred-connection.test.js`
- `test/platform.oauth.test`
- `test/prompt-export.test`
- `test/image-input.test.js`
- `test/editor-image-target.test.js`

## Known limitations

- This project is currently tested for Windows-oriented community-plugin usage. For macOS, see [Aurisper/typora-ai-edit](https://github.com/Aurisper/typora-ai-edit).
- The plugin depends on Typora Community Plugin Framework internals.

## Publish package

The recommended GitHub upload/package directory is this plugin folder itself:

```text
typora-plugin-ai-edit/
```

Place that folder inside their Typora community plugin `plugins` directory.

## Acknowledge

In developing and implementing this project, I used [Aurisper/typora-ai-edit](https://github.com/Aurisper/typora-ai-edit) as a reference and made revisions based on it. Therefore, I would like to express my sincere thanks to its contributor.

## Updated history

- Version 0.1.0: Initial release
- Version 1.1.0: Updated operation logic, added shortcut, optimized expression, added login button
- Version 1.2.0: Fixed login-related issues and added prompt import/export support for easier migration.
- Version 1.3.0: Support an OpenAI-compatible method for using typora-ai-edit plugin.
- Version 1.4.0: Support AI Q&A to image
- Unreleased (Phase 1): Added incremental streaming for both providers, a
  senior linguistics expert and professional editor default persona while
  preserving custom prompts, context-aware formula protection and exact
  placeholder validation, copyable partial results with replacement disabled
  after stop/validation failure, and clears partial output during provider
  failover.

## License

MIT

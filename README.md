# magpie-plugin-bailian-free

[Magpie](https://github.com/yetone/magpie) / OpenCode provider plugin for
Alibaba Cloud Bailian's (阿里云百炼) **new-user free quota**: each model has
its own grant (tokens for text models), valid 90 days from activation,
spent at DashScope's OpenAI-compatible endpoint with the account's own
API key.

The grants can only be read with a console token — the browser console
guards the model list behind its anti-bot check — so the plugin signs in
the way Bailian's official CLI does:

- **浏览器登录**: a one-off listener on 127.0.0.1 and Bailian's
  console-login page; the page hands the console token back once signed
  in. Nothing to paste.
- **百炼 CLI 登录态**: reads `bl login`'s sign-in from
  `~/.bailian/config.json`, read only. Only `bl login` renews it.

A sign-in only counts once its token has actually read the free quota:
the model list is served without a sign-in (a stale token lists models
fine), so a refused token — a `bl login` that has gone stale, or one the
free-quota API won't take — is refused at sign-in with what to do, not
left to quietly fall back to the bootstrap models. When that happens,
run `bl login` again and re-sign-in, or use the browser method.

Requests need a **DashScope API key** (`sk-`): the sign-in makes one
itself, through the console and labelled `magpie-plugin-bailian-free` —
nothing to paste and nothing of yours touched (a pasted `sk-` key is used
when given; a `sk-sp-` Token Plan key can't spend the free quota, so one
is made for those too; deleting the made key on the console's API-KEY
page stops the plugin's requests until the next sign-in makes another).
The quota card lists each chat model's grant,
what is left of it and when it ends — embeddings, rerankers, translation,
image, video and speech grants fold into one line — and the free grants
feed magpie's per-model allowance, so free quota is spent before anything
paid.

Models are never guessed. Bailian's own model catalog — public, no
sign-in needed — carries each model's real context and output limits,
request and response modalities, and features (function calling,
reasoning): the plugin reads it live (with a retry, for a gateway that
now and then drops a connection) and builds every model entry from it.
Signed in, the list is exactly the models whose free grant still has
room, marked free; not signed in (or with nothing left), it is the
catalog's own view of what a fresh account gets, with the catalog's
numbers, marked not free. Image, video, speech and realtime endpoints
are never offered as chat models; their grants still show on the card.

## Install

No npm; magpie installs straight from this git repository. Any one of
these exact forms works — a bare `github.com/…` address (no scheme, no
`github:` prefix) is read as an npm package name and refused:

```sh
magpie plugin add Jindequan/magpie-plugin-bailian-free
magpie plugin add github:Jindequan/magpie-plugin-bailian-free
magpie plugin add https://github.com/Jindequan/magpie-plugin-bailian-free
```

The app's Plugins page takes the same forms in its add box. On macOS the
`magpie` command is the app's own binary — link it once:

```sh
ln -sf /Applications/magpie.app/Contents/MacOS/magpie /opt/homebrew/bin/magpie
```

Then sign in from the app's Plugins page or:

```sh
magpie plugin login bailian-free
```

## Development

```sh
bun test          # fixtures are Bailian's own wire replies
```

| Env var | Overrides |
| --- | --- |
| `BAILIAN_CONSOLE_GATEWAY` | the console gateway the quota is read from |
| `BAILIAN_CONSOLE_LOGIN_PAGE` | the page the browser sign-in opens |
| `BAILIAN_CONFIG_DIR` | where bl's `config.json` lives |

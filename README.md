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

Requests need a **DashScope API key** (`sk-…`, created on the console's
API-KEY page); the browser sign-in asks for it up front, and bl's own key
is picked up from its profile when it has one. The quota card lists each
model's grant, what is left of it and when it ends, and the free grants
feed magpie's per-model allowance, so free quota is spent before anything
paid.

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

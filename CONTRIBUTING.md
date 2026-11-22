# Contributing

Contributions belong in the
[canonical repository](https://github.com/yshaaban/claude-workflow). The Soar
Capital Systems repository is a synchronized mirror and does not accept a
separate stream of changes.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Open an issue before a large behavioral or protocol change so the contract
  can be agreed before implementation.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
  Never put credentials, private prompts, transcripts, or unredacted traces in
  an issue or pull request.

## Development setup

Use Node.js 20 or newer on macOS, Linux, or WSL 2:

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm ci
npm test
npm run test:package
```

The offline suite does not make paid provider requests. It skips installed-CLI
tests when the required executable is missing or too old. For changes to models,
tool routing, or protocol handling, install the [supported CLIs](README.md#requirements)
and run `npm run test:upstream-compatibility`. This check requires both CLIs
and uses controlled provider responses.

Under WSL, keep the checkout, Node.js toolchain, npm cache and prefix, user
configuration, and gateway state on the Linux filesystem. Claude Workflow
setup rejects Windows-mounted paths for these components, and release tests
cover that behavior.

## Pull requests

Keep changes focused and describe the observable behavior they alter. Add a
regression test for bug fixes and contract changes. Run these checks before
opening a pull request:

```bash
npm run check
npm test
npm run test:package
```

For large files or diffs, follow the bounded coverage procedure in
[docs/LARGE_FILES_AND_DIFFS.md](docs/LARGE_FILES_AND_DIFFS.md). A passing test
does not replace review of every changed hunk.

## Publishing documentation

For changes to repository guides or release-page instructions only, update
`main`. Do not move an existing tag. Maintainers with access to the private
UltraThink checkout synchronize its shared guides and runtime files into the
standalone checkout with `node scripts/sync-claude-workflow-standalone.mjs --write`,
then rerun the command with `--check` to verify parity. Public contributors
only need the standalone repository. Keep its README and support instructions specific to the
standalone package. Push the same standalone commit to the canonical repository
and the mirror. If the changes must ship in an installed package, create a new
tag using the release checklist.

## Release checklist

- Use the same install command in the README and release notes, pinned to the
  supported tag and canonical repository:

  ```bash
  npm install --global --allow-git=root \
    git+https://github.com/yshaaban/claude-workflow.git#vX.Y.Z
  ```

- Before tagging, manually run `WSL Smoke` at the current `main` commit in
  UltraThink, the canonical standalone repository, and its mirror. All three
  runs must pass.
- Create an annotated tag once and push that tag to both standalone remotes.
  Verify that both `refs/tags/<tag>^{}` entries peel to the same commit.
- Wait for the tag-triggered CI run to pass in both repositories before
  publishing the GitHub releases.
- After both tags and releases are public, manually run the latest-upstream
  workflow in the canonical repository with `public_tag` set to the new tag.
  Its public-install job must verify that the canonical and mirror tags resolve
  to the same commit and install cleanly before the release is announced.
- On every older release page, replace the existing supersession and install
  block. Do not stack notices. Each old page must point only to the supported
  release and its canonical install command. Keep its original change notes.
  Installing a GitHub tag does not require publishing to the npm registry.

By submitting a contribution, you agree that it may be distributed under the
project's MIT License.

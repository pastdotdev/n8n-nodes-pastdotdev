# Publishing n8n-nodes-pastdotdev

This file gives the steps to publish the package to npm and to submit it to n8n for verification.
There are two roles:

- **The owner**: an owner of the `pastdotdev` GitHub organization and of the `pastdotdev` npm
  account. Sections 1 to 4.
- **The submitter**: the person who submits the node on the n8n Creator Portal. Sections 5 and 6.

n8n verifies a community node only when the package is published from GitHub Actions with an npm
provenance statement (required since 1 May 2026), the repository is public, the license is MIT, and
the npm repository URL is the GitHub repository.

## 1. Create the public repository (owner)

1. On GitHub, create the public repository `pastdotdev/n8n-nodes-pastdotdev`. Make it empty: no
   README, no license, no `.gitignore`. Keep `main` as the default branch.
2. Copy this folder to the root of the new repository. Do not copy `node_modules/` or `dist/`.

   ```bash
   rsync -a --exclude node_modules --exclude dist ./ ../n8n-nodes-pastdotdev/
   cd ../n8n-nodes-pastdotdev
   git init -b main
   git add .
   git commit -m "past dev n8n node 0.1.0"
   git remote add origin https://github.com/pastdotdev/n8n-nodes-pastdotdev.git
   git push -u origin main
   ```

3. Open the **Actions** tab and make sure that the **CI** workflow passes (lint, tests, scan).

## 2. Give the first publish a way to log in to npm (owner)

The package does not exist on npm yet. npm adds a trusted publisher to a package that exists, so
the first publish uses a short-lived token. The publish still gets its provenance statement, because
the provenance comes from the OIDC token of the GitHub Actions job (`id-token: write`).

1. Sign in to npmjs.com as the `pastdotdev` account.
2. Open **Access Tokens > Generate New Token > Granular Access Token**:
   - Expiration: 1 day.
   - Packages and scopes: **Read and write**, all packages (the package does not exist yet).
3. In the GitHub repository, open **Settings > Secrets and variables > Actions > New repository
   secret**. Name it `NPM_TOKEN`, and paste the token.

If npmjs.com lets you add a trusted publisher for the new package name before its first publish,
do step 4 now instead, and do not create the token.

## 3. Publish 0.1.0 (owner)

`package.json` already has the version `0.1.0`. Do not run `npm run release` for this version,
because it bumps the version. Push the tag only:

```bash
git tag 0.1.0
git push origin 0.1.0
```

The **Publish** workflow (`.github/workflows/publish.yml`) then:

1. checks that the tag is the version in `package.json`,
2. runs `npm ci` and `npm test`,
3. runs `npm run release`, which runs lint and build and then `npm publish` with provenance.

Check the result:

```bash
npm view n8n-nodes-pastdotdev version
npm view n8n-nodes-pastdotdev repository.url
```

The npm page of the package must show the **Provenance** section, with a link to the workflow run
and the commit.

## 4. Change to trusted publishing (owner)

1. On npmjs.com, open the package **n8n-nodes-pastdotdev > Settings**.
2. Under **Trusted Publisher**, select **GitHub Actions** and enter:
   - Organization or user: `pastdotdev`
   - Repository: `n8n-nodes-pastdotdev`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
3. Under **Publishing access**, select **Require two-factor authentication and disallow tokens**.
4. Delete the `NPM_TOKEN` secret from the GitHub repository, and delete the token on npmjs.com.

Later releases: on an up-to-date `main`, run `npm run release`. It runs lint and build, asks for the
new version, updates `CHANGELOG.md`, commits, tags, pushes and makes a GitHub release (it needs a
`GITHUB_TOKEN` in the environment for the GitHub release). The tag starts the **Publish** workflow,
which publishes through the trusted publisher. Keep `VERSION` in
`nodes/PastDev/GenericFunctions.ts` equal to the version in `package.json`: a test checks it.

## 5. Run the n8n scanner (submitter)

After the first publish, run n8n's scanner on the published package:

```bash
npx @n8n/scan-community-package n8n-nodes-pastdotdev
```

It checks the provenance statement, fetches the source of the attested commit from GitHub, and
lints the source and the published files. All checks must pass before you submit. Before a
publish, `npm run scan` runs the same lint offline on this folder and on the packed tarball.

## 6. Submit on the n8n Creator Portal (submitter)

1. Open https://creators.n8n.io/nodes and sign in.
2. Submit the package `n8n-nodes-pastdotdev`. Use this text where the portal asks for it:
   - **Name**: past dev
   - **npm package**: `n8n-nodes-pastdotdev`
   - **Repository**: https://github.com/pastdotdev/n8n-nodes-pastdotdev
   - **Short description**: past dev is a memory API for AI agents. Ingest data points, recall the
     memories that answer a query for one person, and delete data points.
   - **Description**: past dev is a memory API for AI agents. It turns the data points that you
     ingest (messages, tickets, notes, transcripts) into memories that keep their sources and
     dates, and it recalls the memories that answer a query for one identity. The node has three
     operations on the resource Memory: Ingest, Recall and Delete Data Point. It can be a tool of
     the AI Agent node. Recall returns the API response and a flat context text for the prompt of
     a model.
   - **Categories**: Data & Storage, Development
   - **Documentation**: https://github.com/pastdotdev/n8n-nodes-pastdotdev#readme and
     https://past.dev/docs/memory-api/api-reference
   - **Website**: https://past.dev
   - **Contact**: louis@past.dev
3. If the reviewers ask for a way to test the node, give them a past dev project API key for a
   test project with a small credit cap, through a private channel. Do not put a key in a public
   form, an issue or the repository.

After approval, the node shows as verified, and people can install it from the nodes panel of n8n,
n8n Cloud included.

## Checklist for the verification rules

| Rule | Where |
| --- | --- |
| Made with the `n8n-node` CLI, `n8n-node lint` passes in strict mode | `package.json` (`n8n.strict`), `npm run lint` |
| Name `n8n-nodes-...`, keyword `n8n-community-node-package` | `package.json` |
| MIT license | `LICENSE`, `package.json` |
| No runtime dependencies | `package.json` has `devDependencies` and a peer dependency on `n8n-workflow` only |
| No environment variables, no file system | `nodes/` and `credentials/` use n8n's request helpers only |
| English only | the node, the credential and the README |
| README with install, credential, operations and example workflows | `README.md`, `examples/` |
| Published from GitHub Actions with provenance | `.github/workflows/publish.yml` |
| npm repository URL is the GitHub repository | `package.json` `repository.url` |

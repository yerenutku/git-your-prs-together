# Privacy policy: Git Your PRs Together

_Last updated: 25 November 2026_

Git Your PRs Together is a browser extension that shows the state of your GitHub pull requests and notifies you when it's your turn.

## What it reads
- **GitHub, as you.** It reads pull request data (lists of PRs, their comments, reviews, review requests, checks and merge state) from the one GitHub address you choose on its options page: github.com or a `*.ghe.com` address. It reads it the way GitHub's own pages do, with your browser's existing GitHub sign-in, or with a personal access token if you enter one.
- **The GitHub pages you open** on that address, to add its labels, tabs and pickers to them.

## What it changes on GitHub
Two features click GitHub's own controls on the page for you, and GitHub saves the result under your account, as if you had clicked them yourself:
- **Auto-viewed** (on by default) marks a pull request's file as "Viewed" after you've read it. You can pause it with the switch on the page, or turn it off for a single file.
- **The reviewers picker**: when you select or unselect someone in its list, it searches for them in GitHub's reviewer picker and clicks their entry there, which requests their review or removes that request.

## What it stores
Everything is stored in your browser's extension storage (`chrome.storage.local` / `browser.storage.local`) on your device:
- your settings, including the optional personal access token;
- the PR data above and which comments and notifications you've already seen.

Removing the extension deletes all of it.

## What it sends, and to whom
- It sends its requests to the GitHub address you chose (and its API address, `api.<that address>`).
- The reviewers picker also shows people's avatars, loaded from the image links GitHub provides. On github.com these are on GitHub's image server, `avatars.githubusercontent.com`.
- It sends **nothing** to the developer or to anyone other than GitHub. There are no analytics, no tracking and no ads.
- It doesn't sell, share or transfer any data, and doesn't use it for anything other than showing you your pull requests.

## Contact
Questions or problems: open an issue on the project's repository.

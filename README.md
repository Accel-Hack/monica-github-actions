# monica-github-actions

GitHub Actions から MONICA へ送る action を置く。npm には公開せず、呼び出し側が commit SHA で固定して使う。

- [`report-failure/`](report-failure/README.md): 失敗した job ごとに、失敗した step のログ末尾を MONICA へ送る composite action
- [`upload-sourcemaps/`](upload-sourcemaps/README.md): build で出た source map を、release とファイル名ごとに MONICA へ上げる composite action

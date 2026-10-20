# upload-sourcemaps

build で出た source map を MONICA へ上げる composite action です。MONICA は、ブラウザと Cloudflare Workers から届いたイベントの frame を、上げた map で元のファイルと行に戻してから Issue にまとめます。

## 組み込む手順

この README を読んで組み込むエージェントも、この順に進めます。1 は人にしかできないので、利用者に頼みます。

1. **人に頼む。** MONICA の管理画面で、プロジェクトの Settings の GitHub に、この workflow を置く repository を選んでもらいます。エージェントは管理画面を操作できません。選ばれていないと、upload は 403 で失敗します。一覧に repository が出ないときは、MONICA の GitHub App をその repository に入れてもらいます。
2. **`project` と `ingest-url` を決める。** SDK に渡している DSN から決めます。MONICA の管理画面が出す DSN は `https://<key>@<host>/<project の slug>` の形です。`project` には末尾の slug を書き、`ingest-url` には `https://<host>` を書きます。本番の Ingest（`ingest.monica.accelhack.net`）なら、`ingest-url` は省けます。
3. **SDK に `release` を渡す。** upload の `release` と同じ値を、SDK の `release` にも渡します。値は commit SHA にします。すでに SDK に `release` を渡しているなら、その値を upload にも使います。
   - ブラウザ（`@ah-monica/browser`）は、build のときに値を埋め込みます。Vite なら、build の環境変数 `VITE_MONICA_RELEASE` に commit SHA を入れ、`Monica.init({ dsn, environment, release: import.meta.env.VITE_MONICA_RELEASE })` と書きます。
   - Cloudflare Workers（`@ah-monica/cloudflare`）は、`wrangler deploy --var MONICA_RELEASE:<deploy する commit の SHA>` で渡し、`createCloudflareClient({ dsn, environment, release: env.MONICA_RELEASE })` と書きます。
4. **bundler で map を出す。** Vite は `build.sourcemap: "hidden"` にします（下の「Vite」）。Workers は `wrangler deploy --dry-run --outdir dist` で bundle と map を書き出します（下の「Cloudflare Workers」）。ほかの bundler では、JS と同じディレクトリに `<JS のファイル名>.map` を出す設定にします。
5. **`path` と `url-prefix` を決める。** `path` は build の出力ディレクトリです。`url-prefix` は、`url-prefix` と「`path` からの相対パスから `.map` を除いたもの」をつないだ値が、ブラウザが JS を取りに行く URL の path と一致するように決めます。
   - build の出力が `dist/assets/index-BkX9a2Qz.js` で、ブラウザが `https://example.com/assets/index-BkX9a2Qz.js` を読むなら、`path: dist`、`url-prefix: /`（既定値）です。
   - Vite の `base` や webpack の `publicPath` を変えているときは、その値を `url-prefix` に書きます。
   - 配信の設定でさらに path が変わる場合は、deploy した HTML の `<script src>` にある path から決めます。
6. **workflow に step を足す。** build の後、deploy の前に置きます（下の「呼び出し方」）。`uses` の `<monica-github-actions の main の SHA>` には、次のコマンドが出す SHA を書きます。

   ```sh
   git ls-remote https://github.com/Accel-Hack/monica-github-actions.git refs/heads/main
   ```

   `actions/checkout` など、ほかの action の `uses` は、呼び出し側の workflow で固定している SHA のまま変えません。

   ブラウザ向けの build では、upload の後、deploy の前に `.map` を消す step も足します。`sourcemap: "hidden"` でも `.map` のファイルは出力ディレクトリに残るので、消さないと map も配信されます。
7. **確かめる。**
   - CI のログに、map ごとに `uploaded <map> as <file>` が出ます。`<file>` が、ブラウザが読む JS の URL の path と一致しているかを見ます。Workers なら、MONICA に届くスタックに出るファイル名と比べます。
   - deploy の後に起きたエラーを、MONICA の Issue 詳細で開きます。スタックが元のファイルと行で出て、source map の注記が無ければ当たっています。注記に map の無いファイル名が出たら、その名前と `<file>` を比べ、`url-prefix` か `release` を直します。

## やってはいけないこと

- `uses` を branch の名前（`@main` など）で書く。monica-github-actions 側の変更が、確かめないまま呼び出し元の CI で動きます。
- deploy の後に上げる。deploy から upload までに届いたイベントは元に戻らないまま、upload の後とは別の Issue にまとまります。
- map をブラウザに配信する。`sourcesContent` に入った元のソースコードを、誰でも読めます。
- MONICA の API key を secret に足す。この action は job の OIDC トークンで認証するので、key は要りません。

## 呼び出し方

build と deploy の間に置きます。

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@<呼び出し側で固定している SHA>
      - run: npm ci && npm run build   # SDK の release に github.sha を渡す（組み込む手順の 3）
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<monica-github-actions の main の SHA>
        with:
          project: my-app
          release: ${{ github.sha }}
          path: dist
      - run: find dist -name '*.map' -delete
      - run: npm run deploy
```

- job の `permissions` に `id-token: write` を書きます。action は job の OIDC トークンで MONICA に認証するので、secret は要りません。`permissions` を書くと、書かなかった権限は無しになるので、checkout のために `contents: read` も書きます。
- `release` は SDK に渡す `release` と同じ値にします。違うと map が当たりません。
- 後から map を上げても、それより前に届いたイベントをまとめ直しはしません。
- map を上げ始めると、そのプロジェクトのブラウザと Workers の Issue は一度だけ割れて、新しい Issue が開きます。新規 Issue の通知も届きます。frame のファイル名が bundle のものから元のソースのものに変わるためです。bundle のファイル名で書いたグルーピングルールと、アラートルールの culprit フィルターも当たらなくなります。

## 上げる内容

- `path` の下にある JavaScript の map（`*.js.map`、`*.mjs.map`、`*.cjs.map`）をすべて上げます。CSS の map は上げません。1 つも無ければ失敗します。
- map 1 つにつき 1 回、`PUT <ingest-url>/v1/sourcemaps?project=<project>&release=<release>&file=<file>` を送り、上げたファイルごとに 1 行ログを出します。
- `file` は、map の `path` からの相対パスから `.map` を除き、前に `url-prefix` を付けたものです。`path: dist`、`url-prefix: /` なら、`dist/assets/index-BkX9a2Qz.js.map` は `/assets/index-BkX9a2Qz.js` として上がります。map は、JS ファイルの名前に `.map` を付けた名前で同じディレクトリに置かれている必要があります。
- MONICA は、frame の `filename` から scheme と host、クエリ、フラグメント、先頭の `/` を除いた名前で map を引きます。`url-prefix` に `https://cdn.example.com/` のような origin を付けても付けなくても、同じ map に当たります。
- map に埋め込まれた元のソースコード (`sourcesContent`) は、消してから上げます。ソースコードは CI の外に出ません。
- 同じ project、release、file に上げ直すと上書きします。job を再実行しても困りません。
- 上げた map が効くまで、最大 60 秒かかります。

## Vite

```ts
// vite.config.ts
export default defineConfig({
  build: { sourcemap: "hidden" },
});
```

```yaml
      - run: npm ci && npm run build
        env:
          VITE_MONICA_RELEASE: ${{ github.sha }}   # SDK の release に import.meta.env.VITE_MONICA_RELEASE を渡す
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<monica-github-actions の main の SHA>
        with:
          project: my-app
          release: ${{ github.sha }}
          path: dist
      - run: find dist -name '*.map' -delete
      - run: npm run deploy
```

- `sourcemap: "hidden"` は map を出しますが、JS に `sourceMappingURL` を書きません。
- `hidden` でも `.map` のファイルは `dist` に残ります。upload の後、deploy の前に消します。消さずに配信すると、map の `sourcesContent` に入った元のソースコードを誰でも読めます。
- Vite の `base` を変えているときは、`url-prefix` に同じ値を書きます。`base: "/app/"` なら `url-prefix: /app/` です。

## Cloudflare Workers

```yaml
      - run: npx wrangler deploy --dry-run --outdir dist
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<monica-github-actions の main の SHA>
        with:
          project: my-worker
          release: ${{ github.sha }}
          path: dist
      - run: npx wrangler deploy --var MONICA_RELEASE:${{ github.sha }}
```

- `wrangler deploy --dry-run --outdir dist` は、deploy と同じ bundle を作って `dist/` に書き、upload せずに終わります。entry が `src/index.ts` なら `dist/index.js` と `dist/index.js.map` ができます。wrangler 4.127.0 では、`upload_source_maps` を設定していなくても map が出ました。
- dry-run と deploy は、それぞれ bundle を作り直します。wrangler 4.127.0 で 2 回 dry-run したところ、同じ JS ができました。
- Worker から届く frame のファイル名は `index.js` になる見込みですが、本番の Worker では確かめていません。そうなら `url-prefix` は既定の `/` のままで当たります。map が当たらないと、MONICA の Issue 詳細に、map が無かったファイル名が出ます。その名前になるように `url-prefix` を直します。
- `wrangler deploy --outdir dist` で deploy しながら bundle を書き出し、その後で上げることもできます。この場合は deploy の後に上げることになるので、その間に届いたイベントは別の Issue になります。
- wrangler の `upload_source_maps = true` は、Cloudflare に map を上げる設定です。Cloudflare の map で元に戻るのは、Cloudflare が扱う未捕捉の例外だけです。SDK が送るイベントの frame は、MONICA に上げた map で戻ります。

## inputs

| input | 必須 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `project` | 必須 | | MONICA のプロジェクトの slug |
| `release` | 必須 | | SDK に渡す `release` と同じ値。commit SHA にします |
| `path` | 必須 | | `*.js.map`、`*.mjs.map`、`*.cjs.map` を探すディレクトリ。下の階層も探します |
| `url-prefix` | | `/` | `path` からの相対パスの前に付ける path。ブラウザや Worker から見えるファイルの path になるように書きます |
| `ingest-url` | | `https://ingest.monica.accelhack.net` | MONICA の Ingest の origin。stg に上げるときは `https://ingest.stg.monica.accelhack.net` です |

## 失敗したとき

失敗すると、step は MONICA の返した status と body をログに出して止まります。その後の map は上げず、後ろの deploy の step も動きません。upload に失敗しても deploy を続けたいなら、この step に `continue-on-error: true` を付けます。そのときは、その release のイベントが元に戻らないまま Issue にまとまります。

- `no GitHub OIDC token available`: job の `permissions` に `id-token: write` がありません。fork からの pull request で動いた run も、トークンを取れないので失敗します (GitHub の挙動で、未確認)。
- 403: この repository が、MONICA のプロジェクトの Settings の GitHub で選ばれていません。
- 413: map が大きすぎます。上限は展開した body で 10 MiB です (暫定)。この action は `sourcesContent` を除いて送るので、それでも超えるときは bundle を分けてください。
- 422: map が source map v3 の JSON ではありません。

## 制約

- npm には公開しません。動くのは、呼び出し側が `uses` に書いた commit の script です。
- GitHub Actions 以外の CI からは上げられません。
- GitHub-hosted runner に入っている bash、curl、jq、gzip を使います。self-hosted runner では、これらを入れておきます。

## 開発

```sh
cd upload-sourcemaps
node --test
```

`upload.test.mjs` は手元に HTTP server を立て、OIDC トークンの発行元と Ingest の代わりにして `upload.sh` を動かします。

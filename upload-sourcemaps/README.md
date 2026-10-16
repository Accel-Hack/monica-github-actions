# upload-sourcemaps

build で出た source map を MONICA へ上げる composite action です。MONICA は、ブラウザと Cloudflare Workers から届いたイベントの frame を、上げた map で元のファイルと行に戻してから Issue にまとめます。

## 呼び出し方

build と deploy の間に置きます。

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    env:
      MONICA_RELEASE: ${{ github.sha }}
    steps:
      - uses: actions/checkout@<commit SHA>
      - run: npm ci && npm run build   # SDK の release に MONICA_RELEASE を渡す
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<commit SHA>
        with:
          project: my-app
          release: ${{ env.MONICA_RELEASE }}
          path: dist
      - run: npm run deploy
```

- `<commit SHA>` には monica-github-actions の main の最新の commit SHA を書きます。branch の名前で書くと、monica-github-actions 側の変更がそのまま呼び出し元の CI で動きます。
- job の `permissions` に `id-token: write` を書きます。action は job の OIDC トークンで MONICA に認証するので、secret は要りません。`permissions` を書くと、書かなかった権限は無しになるので、checkout のために `contents: read` も書きます。
- `release` は SDK に渡す `release` と同じ値にします。違うと map が当たりません。
- MONICA の管理画面で、プロジェクトの Settings の GitHub に、この workflow の repository を選んでおきます。選んでいないと 403 で失敗します。
- deploy の前に上げます。deploy の後に上げると、deploy から upload までに届いたイベントは元に戻らないまま Issue にまとまり、upload の後のイベントとは別の Issue になります。後から map を上げても、まとめ直しはしません。
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
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<commit SHA>
        with:
          project: my-app
          release: ${{ github.sha }}
          path: dist
      - run: find dist -name '*.map' -delete
      - run: npm run deploy
```

- `sourcemap: "hidden"` は map を出しますが、JS に `sourceMappingURL` を書きません。
- map を配信しないなら、upload の後、deploy の前に消します。消さずに配信すると、map の `sourcesContent` に入った元のソースコードを誰でも読めます。
- Vite の `base` を変えているときは、`url-prefix` に同じ値を書きます。`base: "/app/"` なら `url-prefix: /app/` です。

## Cloudflare Workers

```yaml
      - run: npx wrangler deploy --dry-run --outdir dist
      - uses: Accel-Hack/monica-github-actions/upload-sourcemaps@<commit SHA>
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

失敗すると、step は MONICA の返した status と body をログに出して止まります。その後の map は上げません。

- `no GitHub OIDC token available`: job の `permissions` に `id-token: write` がありません。fork からの pull request で動いた run も、トークンを取れないので失敗します (GitHub の挙動で、未確認)。
- 403: この repository が、MONICA のプロジェクトの Settings の GitHub で選ばれていません。
- 413: map が大きすぎます。上限は、展開した body が 32 MiB、`sourcesContent` を除いた map が 10 MiB です (どちらも暫定)。
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

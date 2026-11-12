# edm-action — 上传产物到阿里云盘企业版(企业文件管理/CDE)

GitHub Action: 把构建产物直接传到企业网盘。协议经真实客户端抓包验证(tlsdump 解密 EDM 客户端流量 + 实测跑通),上传链路 `create → 分片 PUT → complete`,支持秒传(SHA1)、CRC64 校验、并发分片、目录自动创建、token 自动刷新。

## 组成

- `action.yml` + `scripts/upload.mjs` — 被其他 workflow 调用的上传 Action(零依赖,Node ≥ 18)
- `token-cli/edm-token.mjs` — 独立 token CLI(本地跑一次,把 token 存进 GitHub Secret)

## 第一步:获取 token(本地,一次性)

```bash
node token-cli/edm-token.mjs login sms --domain <企业代码> --phone 13800138000
# 收到短信后输入 6 位验证码 → token JSON 保存到 ~/.edm-token.json 并打印
```

> 说明: 滑块(阿里云验证码 2.0)只是登录页前端的门槛,服务端不强制校验 `captcha_param`,且官方自带 `skip_captcha=1` 旁路,所以 CLI 可以纯接口完成「手机号+短信验证码 → token」,全程不需要浏览器。链路:`authorize`(拿 SESSIONID) → `send_sms_code` → `signin`(拿 code) → `POST web-sv.aliyunpds.com/get_token`。
> 备用: `node token-cli/edm-token.mjs login browser` 走浏览器登录(CDP 自动读取 token)。

把输出的 JSON 存为仓库 Secret:

```bash
gh secret set EDM_TOKEN --repo <owner>/<repo>   # 粘贴 JSON, Ctrl+D 结束
```

> 关键: `refresh_token` **每次刷新都会轮换**。Action 每次运行会用 refresh_token 换新 access_token;若发生轮换,Action 输出 `refresh_token` 并打 warning。建议在 workflow 里自动更新 Secret(见下),否则 Secret 里的旧 refresh_token 约 7 天后彻底失效。

## 第二步:在 workflow 中调用

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ... 构建产物到 dist/ ...
      - uses: <owner>/edm-action@v1
        id: edm
        with:
          token: ${{ secrets.EDM_TOKEN }}
          files: |
            dist/*.zip
            dist/*.apk
          parent_path: /ci-builds/myapp
      # 可选: 自动把轮换后的 refresh_token 写回 Secret(需要 GH_PAT, 有 repo 写权限)
      - name: Update rotated token
        if: steps.edm.outputs.refresh_token != ''
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}
          NEW_RT: ${{ steps.edm.outputs.refresh_token }}
        run: |
          OLD='${{ secrets.EDM_TOKEN }}'
          NEW=$(echo "$OLD" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s);t.refresh_token=process.env.NEW_RT;console.log(JSON.stringify(t))})")
          printf '%s' "$NEW" | gh secret set EDM_TOKEN --repo ${{ github.repository }}
```

### Inputs

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `token` | ✓ | — | `edm-token login` 输出的 JSON(含 domain_id + refresh_token) |
| `files` | ✓ | — | glob, 多行/空格分隔 |
| `parent_path` | | `/` | 网盘目录, 自动逐级创建 |
| `drive_id` | | 主空间 | 目标空间(优先于 drive_name) |
| `drive_name` | | 主空间 | 按名称选团队空间, 如 `某个团队空间`; 名字写错会列出全部可选空间 |
| `check_name_mode` | | `auto_rename` | 同名策略: `refuse`/`ignore`/`overwrite` |
| `concurrency` | | `3` | 分片并发 |
| `part_size` | | `10485760` | 分片字节数(10MB) |

### Outputs

- `results` — JSON 数组 `[{name, file_id, drive_id, size, sha1, rapid_upload}]`
- `refresh_token` — 轮换后的新 refresh_token(若本次运行发生了刷新轮换)

## 实测验证记录(2026-11-12, 企业域 <domain_id>)

- 明文 JSON `POST /v2/file/create` → 201(无需任何请求体加密)
- 分片 PUT `https://{store_id}.data.aliyunfile.com/...`(预签名 URL, `Content-Type` 必须与服务端 `part_info_list[].content_type` 完全一致,**含空串**)
- `POST /v2/file/complete` 的 etag **必须带引号**(与服务端存储格式一致)
- 同内容重传 → `rapid_upload: true` 秒传;同名不同内容 auto_rename 正常
- 刷新: `POST {auth_endpoint}/v2/account/token` JSON `{app_id, refresh_token, grant_type:"refresh_token"}`,**refresh_token 每次轮换**
- 回收站: `POST /v2/recyclebin/trash`(进回收站) → `POST /v2/file/delete {permanently:true}`(彻底删除)

## 免责

该 Action 使用客户端同款内部 API, 非官方公开接口, 可能随服务端升级失效。凭据仅经 Secret 传入, 不会出现在日志。

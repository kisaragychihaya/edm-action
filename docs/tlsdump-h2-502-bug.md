# tlsdump tun 模式 MITM 失败导致上传 502 — 问题分析

> 日期: 2026-11-12 · 工具: tlsdump-windows-amd64.exe (PdWolf-tlsdump, tun 模式) · 状态: 待修复

## 现象

tun 模式下用企业网盘客户端(阿里云盘企业版 EDM,上传进程为 Go 编写的 `datatransfer.exe`)上传文件:

- 客户端侧: 上传持续失败重试(每 ~11 秒调一次 `/v2/file/get_upload_url` 刷新上传地址),界面报 502
- tlsdump 侧: `rec.jsonl` 中**完全没有** `PUT *.data.aliyunfile.com` 的记录(连接在 MITM 环节就失败了,请求没走到记录阶段)
- API 侧正常: 同一会话里 `POST /v2/file/create` → 201、`/v2/file/get_upload_url` → 200,均成功被记录

## 关键日志

```
time=2026-11-12T14:10:55.980+08:00 level=DEBUG msg="intercept TLS" sni=<store_id>.data.aliyunfile.com dst=<upstream_ip>:443
time=2026-11-12T14:10:56.302+08:00 level=DEBUG msg="h2 upstream round trip failed" host=<store_id>.data.aliyunfile.com err="http2: failed reading the frame payload: http2: frame too large, note that the frame header looked like an HTTP/1.1 header"
time=2026-11-12T14:10:58.403+08:00 level=DEBUG msg="h2 upstream round trip failed" ... (同样错误,每 ~2 秒重试一次)
```

## 根因分析

`*.data.aliyunfile.com` 是 OSS 协议网关(响应头 `server: AliyunOSS`),该端口上**实际只说 HTTP/1.1**(或 ALPN 协商结果为 http/1.1)。但 tlsdump 的上游连接使用了 Go 的 `http2.Transport` 去读响应:

1. 客户端 → tlsdump: ALPN 协商 h2,MITM 正常建立(所以日志有 `intercept TLS`)
2. tlsdump → 上游: 协商/假定 h2,但上游返回的是 HTTP/1.1 明文响应
3. Go http2.Transport 把 `HTTP/1.1 200 OK` 这样的文本行当 h2 frame header 解析 → `frame too large` 错误
4. tlsdump 向上游请求失败 → 给客户端回 502 → 客户端无限刷新 upload_url 重试

佐证: 同一 MITM 实例下,`<domain_id>.api.aliyunfile.com`(Kaede 网关)的上传 API 调用全部正常记录,说明该上游正确协商了 h2;只有 `*.data.aliyunfile.com`(AliyunOSS)失败——**问题精确复现在"上游不支持 h2 的域名"上**。

## 复现条件

- tlsdump `-mode tun`,白名单包含目标域名(此处 `aliyunfile.com`)
- 目标服务器在该端口不支持 HTTP/2(或 ALPN 仅接受 http/1.1)
- 客户端对该域名发起请求(此处为 OSS 预签名 PUT 上传)

最小复现思路: 任意 h2 强制场景,如 `curl --http2-prior-knowledge` 风格的服务器,或直接用不支持 h2 的服务器域名经 tun 访问。

## 修复方向(供参考)

1. **按 ALPN 结果选上游 Transport**: 上游 TLS 握手后检查 `ConnectionState().NegotiatedProtocol`;为 `h2` 才用 `http2.Transport`,否则(空/`http/1.1`)用默认 `http.Transport`。这是根治。
2. **失败回退**: `h2 upstream round trip failed` 且错误含 `frame header looked like an HTTP/1.1 header` 时,用 http/1.1 重试一次该请求。
3. **502 语义**: 上游协商失败时给客户端的 502 无区分度,建议在响应头(如 `X-Tlsdump-Error`)或日志 WARN 中明确"上游 h2 协商失败",避免误判为服务端故障。

## 环境信息

- OS: Windows 11, wintun 0.14(embedded)
- 配置: `mode: tun`, `domains: [aliyunfile.com, aliyunpds.com, aliyuncs.com]`, `body_limit: 131072`, `verbose: true`
- 上游: `<store_id>.data.aliyunfile.com:443` (<upstream_ip>, server: AliyunOSS)
- 完整抓包记录: `capture/rec.jsonl`(上传尝试在 14:10:55–14:13 时段);tlsdump 完整日志含每 2 秒一次的 `h2 upstream round trip failed`

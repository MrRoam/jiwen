# 服务器部署、备份与恢复

本方案用于一台安装 Docker Compose 的 Linux 服务器。应用单实例运行，SQLite 和录音放在持久卷，Caddy 提供 HTTPS、WebSocket 和流式问答代理。仅开放 80、443 端口，应用的 4317 端口不映射到公网。

## 上线

1. 将域名的 DNS 指向服务器，开放服务器的 TCP 80、443 端口。
2. 把项目代码放到服务器；不要把本机 `data/`、`.env`、`node_modules/` 或录音上传到公开仓库或构建上下文。
3. 在服务器项目根目录把 `.env.example` 复制为 `.env`，增加 `SITE_DOMAIN=你的域名`（只填主机名，不带协议或路径）。Linux 上执行 `chmod 600 .env`。
4. 在项目根目录执行 `docker compose up -d --build`，用 `docker compose ps` 和 `docker compose logs --tail=80` 检查启动结果。
5. 打开 `https://你的域名`，在受控访问环境注册自己的管理员账号，再从侧栏「API 配置」填写密钥并测试转写和问答，再用实际手机录音、暂停及回放，确认后分享链接。

部署使用远程语音转写，可在页面配置有效的百炼 Key；不包含本机 Python 转写服务。Compose 固定安全 Cookie、容器监听地址和数据目录；页面保存的 API 配置在持久卷中，立即生效；额度和可选功能读取服务器 `.env`。默认最多 100 个账号，无需邀请码，拿到链接的人在名额内均可注册。`ADMIN_EMAIL` 仅用于选择管理员账号，邮箱注册不验证所有权，公开分享前先完成管理员注册。

Caddy 会为指向服务器的域名自动申请证书，要求域名解析正确且端口可达，参见 [官方说明](https://caddyserver.com/docs/quick-starts/reverse-proxy)。

云端使用新的数据库，不自动搬迁本机账号或课堂。账号密码至少 8 位。当前登录防刷按代理连接地址统计，所有试用者合计每 10 分钟最多 40 次注册或登录尝试，适合此次少人数试用。

## 更新和备份

更新代码后运行 `docker compose up -d --build`。更新和重启会中断正在进行的录音、转写与回答，应选择无人使用时操作。普通重建保留命名卷；不要执行 `docker compose down -v`，它会删除数据卷。

为同时保全 SQLite 和录音，备份前停止应用，完整归档数据目录后再启动（在服务器项目根目录执行）：

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app
docker compose run --rm --no-deps -T --user root app tar -C /app/data -czf - . > "backups/classroom-$(date +%Y%m%d-%H%M%S).tgz"
docker compose start app
```

确认归档命令成功、文件非空，并定期把备份保存到另一台受控设备。备份包含账号数据库和课堂录音，应限制访问。恢复时先停止应用，将归档完整解压到应用数据卷，并确保文件归容器 `node` 用户所有，再启动检查账号与录音。

## 验证范围

本地可检查 Compose 配置及前端构建；Linux 镜像构建、证书签发、真实域名下的录音与流式链路需要在目标服务器完成。完成这些检查之前不能视为已上线。

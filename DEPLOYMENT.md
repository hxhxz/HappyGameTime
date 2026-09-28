# 宝可梦规则引擎陪练

固定 1 位真人 + 3 位本地规则 agent：赤焰（抢分）、青岚（进化）、紫苑（控场）。

## 使用

生产入口、主机地址和访问口令由部署方私下配置，不写入仓库。
输入专用访问口令即可开始。三位陪练直接执行本地人格化规则引擎的最高分候选，不调用外部模型或产生 token 费用。

访问口令在独立 `.env` 中，不要提交该文件。
对局和最近 200 条决策说明自动保存至 `data/game.json`，刷新浏览器继续。进程重启后默认暂停，手动继续。

## 构建与验证

```sh
npm ci
npm run sprites
npm test
npm run build
```

生产只运行 `build/server.mjs`，不安装或暴露 Vite / Vitest / WebSocket 开发服务。基础镜像为 Node 22 Alpine。规则引擎不信任前端动作，服务端只执行合法候选中的最高分动作。

本地预览（不要使用线上口令）：
```sh
ACCESS_PASSWORD=your-local-password COOKIE_SECURE=false DATA_DIR=/tmp/pokemon-dev node build/server.mjs
```
然后访问 `http://127.0.0.1:8788/pokemon/`。

## 部署隔离

- 独立目录：`<APP_DIR>`
- 独立容器：`pokemon-trainer`
- 独立持久目录：`<APP_DIR>/data`，UID/GID 1000
- 仅监听回环端口：`127.0.0.1:8788`
- Caddy 精确匹配 `/pokemon` 和 `/pokemon/*`，转发至游戏服务；主页其余路由保持原样。
- HTTP 到 HTTPS 等公网重定向由站点管理员单独配置。
- Cookie 名称和 Path 独立，HttpOnly / Secure / SameSite=Strict。
- 容器非 root、只读根目录、移除 Linux capabilities、限制内存/CPU。

部署前把 dist、build/server.mjs、Dockerfile、compose.yaml 放至独立目录，准备 `.env` 和 data 权限，然后：
```sh
cd <APP_DIR>
docker compose up -d --build
curl -fsS http://127.0.0.1:8788/pokemon/api/health
GAME_DOMAIN=<your-domain> python3 deploy/install-route.py
```

路由脚本只在找到一个由 `GAME_DOMAIN` 指定的独立站点时插入游戏 handle，校验成功才替换，保留有时间戳的原始 Caddy 配置备份；重载失败自动回滚。停止游戏可在应用目录执行 `docker compose stop`；不要操作其他 compose 项目。

## 规则与数据来源

引擎改编自 [LeonJoeeee/splendor-pokemon](https://github.com/LeonJoeeee/splendor-pokemon)，保留 MIT 许可。
规则核对：[RulesPal Pokémon Splendor](https://www.rulespal.com/splendor-pokemon/rulebook)。
90 张卡表来自上游社区转录，尚未逐张对照实体卡；55 个物种插画来自 PokéAPI 社区图片库，权利归各自权利人。非官方、非商业同人陪练。

纠正了上游的取球数量约束、无效颜色/弃球验证、已触发终局的轮末判断；弃球动作枚举覆盖所有可选组合。
当前支付采用先使用对应颜色球、缺额用大师球的自动结算，不提供主动多花大师球保留普通球的支付编辑器。

## 验证范围

规则单元测试、自动对弈、隐藏信息期望值、JSON 动作边界、私有 HTTP 登录、三个规则 agent 的轮转、评分分项存档、浏览器取球和手机无横向溢出。

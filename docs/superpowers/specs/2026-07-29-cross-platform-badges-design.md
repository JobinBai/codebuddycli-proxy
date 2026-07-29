# 跨平台链接徽标设计

## 目标

在 GitHub README 与 Docker Hub 说明文档顶部提供相互跳转的小型品牌徽标。

## 实现

- `README.md` 标题下添加 Docker Hub Shields.io 徽标，链接到 `https://hub.docker.com/r/jobinbai/codebuddycli-proxy`。
- `DOCKERHUB.md` 标题下添加 GitHub Shields.io 徽标，链接到 `https://github.com/JobinBai/codebuddycli-proxy`。
- 使用 Markdown 图片链接，不添加本地图片资产。

## 验证

确认两个目标 URL、徽标图片 URL 和文档首行位置正确；不改变现有部署说明。

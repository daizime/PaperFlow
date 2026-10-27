# PaperFlow 项目约束

回答前保持独立判断，优先指出问题和风险。数据、案例和引用须核定来源；无法确定则明确标注。

严格按 T01 → T02 → T03 实施，阶段测试通过后继续。不得关闭 Electron sandbox、contextIsolation、webSecurity。前端只使用 window.paperflow 业务 API。禁止接入 LLM、云服务、OCR、Python 翻译依赖或自动远程发布。

协作入口：项目管理/README.md。主控独占共享接口、构建配置和总体验收；临时代理仅写明确授权的路径。未创建持久模块会话，不能将临时代理登记为持久会话。

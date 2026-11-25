import './study.css'

export interface ShortcutsModalProps {
  open: boolean
  onClose(): void
}

const SHORTCUT_GROUPS: Array<{
  title: string
  items: Array<{ keys: string[]; description: string }>
}> = [
  {
    title: '阅读与导航',
    items: [
      { keys: ['←', '→'], description: '上一页 / 下一页' },
      { keys: ['PgUp', 'PgDn'], description: '快速前后翻页' },
      { keys: ['Home', 'End'], description: '跳到首页 / 末页' },
      { keys: ['Ctrl', '+ / -'], description: '放大 / 缩小页面' },
      { keys: ['Ctrl', '0'], description: '自适应页面宽度' },
      { keys: ['Ctrl', 'F'], description: '文内全文搜索' }
    ]
  },
  {
    title: '界面与精读操作',
    items: [
      { keys: ['T'], description: '循环切换阅读主题（明亮 / 护眼 / 深色）' },
      { keys: ['V'], description: '切换视图模式（双栏 / 译文 / 原文）' },
      { keys: ['B'], description: '展开 / 收起左侧文献库' },
      { keys: ['O'], description: '打开 / 关闭文档目录' },
      { keys: ['A'], description: '打开 / 关闭批注与笔记面板' },
      { keys: ['C'], description: '打开引用复制面板（BibTeX / IEEE / GB/T）' },
      { keys: ['H'], description: '快速对当前选中句添加黄色高亮' },
      { keys: ['?'], description: '显示 / 关闭快捷键一览' },
      { keys: ['Esc'], description: '关闭当前浮窗或清除选中状态' }
    ]
  }
]

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps): React.JSX.Element | null {
  if (!open) return null

  return (
    <div
      className="translation-modal-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="translation-modal study-modal" role="dialog" aria-modal="true" aria-label="快捷键一览">
        <div className="translation-modal__header">
          <h3>快捷键一览</h3>
          <button type="button" className="translation-modal__close" aria-label="关闭快捷键面板" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="translation-modal__body study-shortcuts-body">
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title} className="study-shortcuts-group">
              <h4>{group.title}</h4>
              <ul className="study-shortcuts-list">
                {group.items.map(item => (
                  <li key={item.description} className="study-shortcuts-row">
                    <span>{item.description}</span>
                    <span className="study-shortcuts-keys">
                      {item.keys.map(k => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="translation-modal__footer">
          <span className="translation-modal__hint">提示：在输入框内打字时单键快捷键会自动禁用。</span>
          <div className="translation-modal__footer-right">
            <button type="button" className="translation-modal__primary" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

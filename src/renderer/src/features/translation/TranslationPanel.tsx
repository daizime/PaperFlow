export function TranslationPanel(): React.JSX.Element {
  return (
    <aside className="translation-panel" aria-label="译文区域">
      <div className="panel-heading"><h2>译文</h2></div>
      <div className="translation-scroll">
        <div className="translation-empty"><h3>尚未翻译</h3></div>
      </div>
    </aside>
  )
}

interface Boundary { node: Node; offset: number }
interface LayerRegistration {
  root: HTMLDivElement
  textDivs: Set<HTMLElement>
  adjacentTextDivs: Map<HTMLElement, readonly HTMLElement[]>
}
interface PointerPosition {
  mouseType: string; x: number; y: number; target: EventTarget | null; buttons: number; trusted: boolean
}
interface MouseSelection {
  origin: HTMLElement
  root: HTMLDivElement
  blocked: boolean
  readonly anchor: Boundary | null
  focus: Boundary | null
  lastText: Text | null
  pointer: { x: number; y: number }
  edge: { x: number; y: number }
}
const layers = new Map<HTMLElement, LayerRegistration>()
let listeners: AbortController | null = null
let gesture: MouseSelection | null = null
let pointerType = 'mouse'
let pointerPosition: PointerPosition | null = null
let applying = false
let scrollFrame: number | null = null
let scrollTime = 0
let scrollRemainder = { x: 0, y: 0 }

function stopAutoScroll(): void {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  scrollFrame = null
  scrollTime = 0
  scrollRemainder = { x: 0, y: 0 }
}

function stopGesture(): void {
  stopAutoScroll()
  gesture = null
  pointerPosition = null
}

function recordPointer(event: PointerEvent): void {
  if (event.type === 'pointerdown' && (event.pointerType !== 'mouse' || !event.isPrimary)) stopGesture()
  if (gesture && event.pointerType === 'mouse' && event.type === 'pointermove' && event.buttons !== 1) stopGesture()
  if (event.type === 'pointerup') stopAutoScroll()
  pointerType = event.pointerType
  pointerPosition = event.pointerType === 'mouse' && event.isPrimary ? {
    mouseType: event.type.replace('pointer', 'mouse'), x: event.clientX, y: event.clientY,
    target: event.target, buttons: event.buttons, trusted: event.isTrusted
  } : null
}

function mousePosition(event: MouseEvent): { x: number; y: number } {
  const pointer = pointerPosition
  pointerPosition = null // 只供紧随其后的兼容事件消费一次，禁止沿用旧坐标。
  if (pointer && pointer.mouseType === event.type && pointer.target === event.target && pointer.buttons === event.buttons && pointer.trusted === event.isTrusted &&
    Math.abs(pointer.x - event.clientX) < 1 && Math.abs(pointer.y - event.clientY) < 1) return { x: pointer.x, y: pointer.y }
  return { x: event.clientX, y: event.clientY }
}

function registeredText(node: Node | null): node is Text {
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.isConnected) return false
  let element = node.parentElement
  const layer = element?.closest<HTMLElement>('.textLayer')
  const registration = layer && layers.get(layer)
  if (!registration) return false
  while (element && element !== layer) {
    if (registration.textDivs.has(element)) return true
    element = element.parentElement
  }
  return false
}

function caretAt(x: number, y: number): Boundary | null {
  const caret = document.caretPositionFromPoint?.(x, y)
  if (caret) return { node: caret.offsetNode, offset: caret.offset }
  const range = document.caretRangeFromPoint(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

function characterHit(node: Text, indices: readonly number[], x: number, y: number, caretOffset?: number): Boundary | null {
  for (let index of indices) {
    if (index < 0 || index >= node.length) continue
    const code = node.data.charCodeAt(index)
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) index--
    const character = String.fromCodePoint(node.data.codePointAt(index)!)
    if (!character.trim()) continue
    const end = index + character.length
    const range = document.createRange()
    range.setStart(node, index)
    range.setEnd(node, end)
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0 && x >= rect.left - 0.25 && x <= rect.right + 0.25 && y >= rect.top - 0.25 && y <= rect.bottom + 0.25) {
        if (caretOffset !== undefined) return { node, offset: Math.max(index, Math.min(end, caretOffset)) }
        // 遮挡时原生 caret 属于空格节点；仅在已命中的字符两端之间确定方向。
        let boundary: Boundary | null = null
        let distance = Infinity
        for (const offset of [index, end]) {
          range.setStart(node, offset)
          range.collapse(true)
          for (const edge of range.getClientRects()) {
            const dx = Math.max(edge.left - x, 0, x - edge.right)
            const dy = Math.max(edge.top - y, 0, y - edge.bottom)
            const candidate = dx * dx + dy * dy
            if (candidate < distance) { distance = candidate; boundary = { node, offset } }
          }
        }
        return boundary
      }
    }
  }
  return null
}

function textDivHit(element: HTMLElement, x: number, y: number): Boundary | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!registeredText(node)) continue
    const hit = characterHit(node, Array.from({ length: node.length }, (_, index) => index), x, y)
    if (hit) return hit
  }
  return null
}

/** 真实叠层及命中空格的原索引邻项均须通过字符 Range，不吸附全页最近文字。 */
function textHit(x: number, y: number): Boundary | null {
  const caret = caretAt(x, y)
  if (caret && registeredText(caret.node)) {
    const hit = characterHit(caret.node, [caret.offset, caret.offset - 1], x, y, caret.offset)
    if (hit) return hit
  }
  const visited = new Set<HTMLElement>()
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof HTMLElement)) continue
    const layer = element.closest<HTMLElement>('.textLayer')
    const registration = layer && layers.get(layer)
    if (!registration) continue
    let owner: HTMLElement | null = element
    while (owner && owner !== layer && !registration.textDivs.has(owner)) owner = owner.parentElement
    if (!owner || !registration.textDivs.has(owner) || visited.has(owner)) continue
    visited.add(owner)
    const directHit = textDivHit(owner, x, y)
    if (directHit) return directHit
    if (!owner.textContent || owner.textContent.trim()) continue
    // Chromium 的像素命中可能遗漏已覆盖该点的相邻单字；只试原索引前后各一项。
    let adjacentHit: Boundary | null = null
    for (const adjacent of registration.adjacentTextDivs.get(owner) ?? []) {
      if (!adjacent.isConnected || adjacent.closest('.textLayer') !== layer || !registration.textDivs.has(adjacent)) continue
      const hit = textDivHit(adjacent, x, y)
      if (!hit) continue
      if (adjacentHit) return null // 两邻同时覆盖时保留歧义，不任意选择。
      adjacentHit = hit
    }
    if (adjacentHit) return adjacentHit
  }
  return null
}

function readerAt(event: MouseEvent, point: { x: number; y: number }): HTMLDivElement | null {
  if (!(event.target instanceof Node)) return null
  for (const { root } of layers.values()) {
    if (!root.contains(event.target)) continue
    const bounds = root.getBoundingClientRect()
    const left = bounds.left + root.clientLeft
    const top = bounds.top + root.clientTop
    // 客户区不包含原生滚动条；工具栏也不在root内。
    if (point.x >= left && point.x < left + root.clientWidth && point.y >= top && point.y < top + root.clientHeight) return root
  }
  return null
}

function nearestBoundary(node: Text, x: number, y: number): Boundary | null {
  if (!registeredText(node)) return null
  let closest: Boundary | null = null
  let distance = Infinity
  const range = document.createRange()
  for (let offset = 0; offset <= node.length; offset++) {
    if (offset > 0 && offset < node.length && /[\uD800-\uDBFF]/.test(node.data[offset - 1]) && /[\uDC00-\uDFFF]/.test(node.data[offset])) continue
    range.setStart(node, offset)
    range.collapse(true)
    for (const rect of range.getClientRects()) {
      const dx = Math.max(rect.left - x, 0, x - rect.right)
      const dy = Math.max(rect.top - y, 0, y - rect.bottom)
      const candidate = dx * dx + dy * dy
      if (candidate < distance) { distance = candidate; closest = { node, offset } }
    }
  }
  return closest
}

function restoreFocus(): void {
  const selection = document.getSelection()
  const anchor = gesture?.anchor
  const focus = gesture?.focus
  if (!selection || !anchor || !focus || !anchor.node.isConnected || !focus.node.isConnected) return
  if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset && selection.focusNode === focus.node && selection.focusOffset === focus.offset) return
  applying = true
  try { selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset) }
  finally { applying = false }
}

function textInRoot(node: Node | null, root: HTMLDivElement): node is Text {
  if (!registeredText(node)) return false
  const layer = node.parentElement?.closest<HTMLElement>('.textLayer')
  return !!layer && layers.get(layer)?.root === root
}

function activeSelection(): MouseSelection | null {
  const active = gesture
  if (!active || active.blocked) return null
  if (!active.root.isConnected || !textInRoot(active.anchor?.node ?? null, active.root) || !textInRoot(active.lastText, active.root)) {
    stopGesture()
    return null
  }
  return active
}

/** 只有真实移动采样指针线段；滚动后只用当前client点重算，不重放旧路径。 */
function refreshFocus(point: { x: number; y: number }, samplePath: boolean): void {
  const active = activeSelection()
  if (!active) return
  if (samplePath) {
    const dx = point.x - active.pointer.x
    const dy = point.y - active.pointer.y
    const steps = Math.min(1024, Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2)))
    for (let step = 1; step <= steps; step++) {
      const crossed = textHit(active.pointer.x + dx * step / steps, active.pointer.y + dy * step / steps)
      if (crossed && textInRoot(crossed.node, active.root)) { active.focus = crossed; active.lastText = crossed.node }
    }
    active.pointer = point
  }
  const hit = textHit(point.x, point.y)
  if (hit && textInRoot(hit.node, active.root)) { active.focus = hit; active.lastText = hit.node }
  else if (active.lastText) active.focus = nearestBoundary(active.lastText, point.x, point.y) ?? active.focus
  restoreFocus()
}

function clientArea(root: HTMLDivElement): { left: number; top: number; right: number; bottom: number } {
  const rect = root.getBoundingClientRect()
  const left = rect.left + root.clientLeft
  const top = rect.top + root.clientTop
  return { left, top, right: left + root.clientWidth, bottom: top + root.clientHeight }
}

function edgeIntent(position: number, start: number, end: number, delta: number, previous: number): number {
  const band = Math.min(36, (end - start) / 4)
  if (position < start || position >= end) return 0
  if (position < start + band) return delta < 0 || (delta === 0 && previous < 0) ? -1 : 0
  if (position > end - band) return delta > 0 || (delta === 0 && previous > 0) ? 1 : 0
  return 0
}

function edgeSpeed(position: number, start: number, end: number, intent: number): number {
  const band = Math.min(36, (end - start) / 4)
  if (band <= 0 || position < start || position >= end) return 0
  if (intent < 0) return -480 * Math.max(0, Math.min(1, (start + band - position) / band))
  if (intent > 0) return 480 * Math.max(0, Math.min(1, (position - end + band) / band))
  return 0
}

function scheduleAutoScroll(active: MouseSelection): void {
  if (scrollFrame !== null || gesture !== active || (!active.edge.x && !active.edge.y)) return
  if (scrollTime === 0) scrollTime = performance.now()
  scrollFrame = requestAnimationFrame(time => {
    scrollFrame = null
    if (gesture !== active || activeSelection() !== active) { stopAutoScroll(); return }
    const area = clientArea(active.root)
    const point = active.pointer
    if (point.x < area.left || point.x >= area.right || point.y < area.top || point.y >= area.bottom) {
      active.edge = { x: 0, y: 0 }
      stopAutoScroll()
      return
    }
    const elapsed = Math.min(32, Math.max(0, time - scrollTime))
    scrollTime = time
    const left = active.root.scrollLeft
    const top = active.root.scrollTop
    const speedX = edgeSpeed(point.x, area.left, area.right, active.edge.x)
    const speedY = edgeSpeed(point.y, area.top, area.bottom, active.edge.y)
    const canX = speedX < 0 ? left > 0 : speedX > 0 && left < active.root.scrollWidth - active.root.clientWidth
    const canY = speedY < 0 ? top > 0 : speedY > 0 && top < active.root.scrollHeight - active.root.clientHeight
    if (!canX && !canY) { stopAutoScroll(); return }
    // 首帧零dt或亚像素量化不代表到边界；保留余量，按真实可滚动范围决定停止。
    scrollRemainder.x = canX ? scrollRemainder.x + speedX * elapsed / 1000 : 0
    scrollRemainder.y = canY ? scrollRemainder.y + speedY * elapsed / 1000 : 0
    const stepX = Math.trunc(scrollRemainder.x)
    const stepY = Math.trunc(scrollRemainder.y)
    scrollRemainder.x -= stepX
    scrollRemainder.y -= stepY
    active.root.scrollLeft += stepX
    active.root.scrollTop += stepY
    if (left !== active.root.scrollLeft || top !== active.root.scrollTop) refreshFocus(point, false)
    scheduleAutoScroll(active)
  })
}

function move(event: MouseEvent, point: { x: number; y: number }): void {
  if (!gesture) return
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || (event.type === 'mousemove' && event.buttons !== 1)) { stopGesture(); return }
  event.preventDefault()
  if (gesture.blocked) return
  const active = activeSelection()
  if (!active) return
  const previous = active.pointer
  const previousEdge = active.edge
  const area = clientArea(active.root)
  if (point.x >= area.left && point.x < area.right && point.y >= area.top && point.y < area.bottom) {
    active.edge = {
      x: edgeIntent(point.x, area.left, area.right, point.x - previous.x, active.edge.x),
      y: edgeIntent(point.y, area.top, area.bottom, point.y - previous.y, active.edge.y)
    }
  } else active.edge = { x: 0, y: 0 }
  if (active.edge.x !== previousEdge.x) scrollRemainder.x = 0
  if (active.edge.y !== previousEdge.y) scrollRemainder.y = 0
  refreshFocus(point, true)
  if (active.edge.x || active.edge.y) scheduleAutoScroll(active)
  else stopAutoScroll()
}

function installListeners(): void {
  if (listeners) return
  listeners = new AbortController()
  const options = { capture: true, signal: listeners.signal }
  document.addEventListener('pointerdown', recordPointer, options)
  document.addEventListener('pointermove', recordPointer, options)
  document.addEventListener('pointerup', recordPointer, options)
  document.addEventListener('mousedown', event => {
    const point = mousePosition(event)
    stopGesture()
    if (pointerType !== 'mouse' || event.button !== 0 || event.detail !== 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    const reader = readerAt(event, point)
    if (!reader) return
    event.preventDefault()
    const beforeFocus = textHit(point.x, point.y)
    const beforeArea = clientArea(reader)
    const beforeScroll = { top: reader.scrollTop, left: reader.scrollLeft }
    reader.focus({ preventScroll: true })
    const afterFocus = readerAt(event, point) === reader ? textHit(point.x, point.y) : null
    const afterArea = clientArea(reader)
    const moved = beforeScroll.top !== reader.scrollTop || beforeScroll.left !== reader.scrollLeft ||
      beforeArea.left !== afterArea.left || beforeArea.top !== afterArea.top || beforeArea.right !== afterArea.right || beforeArea.bottom !== afterArea.bottom
    // 页码blur可能同步beginAnchor；尊重提交，仅取消这次受导航/几何变化影响的起拖。
    const hit = !moved && reader.dataset.navigationAnchor !== 'true' && document.activeElement === reader && beforeFocus && afterFocus &&
      beforeFocus.node === afterFocus.node && beforeFocus.offset === afterFocus.offset && textInRoot(afterFocus.node, reader) ? afterFocus : null
    const origin = hit?.node.parentElement?.closest<HTMLElement>('.textLayer') ?? reader
    if (!hit) {
      // 仅显式的无修饰主键空白起拖清掉旧选区，不在mouseup/键盘/复制时清空。
      document.getSelection()?.removeAllRanges()
      gesture = { origin, root: reader, blocked: true, anchor: null, focus: null, lastText: null, pointer: point, edge: { x: 0, y: 0 } }
      return
    }
    gesture = { origin, root: reader, blocked: false, anchor: hit, focus: hit, lastText: hit.node as Text, pointer: point, edge: { x: 0, y: 0 } }
    restoreFocus()
  }, options)
  document.addEventListener('mousemove', event => { move(event, mousePosition(event)) }, options)
  document.addEventListener('dragstart', event => {
    if (!gesture || gesture.blocked || pointerType !== 'mouse' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
      !registeredText(gesture.anchor?.node ?? null) || !registeredText(gesture.lastText)) return
    if (!(event.target instanceof Node)) return
    const source = event.target instanceof HTMLElement ? event.target : event.target.parentElement
    const layer = source?.closest<HTMLElement>('.textLayer')
    const registration = layer && layers.get(layer)
    const origin = layers.get(gesture.origin)
    if (!registration || !origin || registration.root !== origin.root) return
    let owner: HTMLElement | null = source
    while (owner && owner !== layer && !registration.textDivs.has(owner)) owner = owner.parentElement
    if (!owner || !registration.textDivs.has(owner) || !owner.textContent) return
    // 当前普通 PDF 拖选不可转为 HTML 文字拖放；真正的 pointercancel 仍按原路径释放。
    event.preventDefault()
  }, options)
  document.addEventListener('selectionchange', () => {
    if (applying || !gesture || gesture.blocked) return
    // 原生选择可能因脚本端点校正而迁移anchor；本次普通拖拽始终保留初始起点。
    restoreFocus()
  }, { signal: listeners.signal })
  document.addEventListener('mouseup', event => { const point = mousePosition(event); if (event.button === 0) { move(event, point); stopGesture() } }, options)
  document.addEventListener('pointercancel', stopGesture, options)
  document.addEventListener('mouseout', event => { if (event.relatedTarget === null) stopGesture() }, options)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) stopGesture()
  }, { signal: listeners.signal })
  document.addEventListener('focusin', event => {
    if (gesture && event.target instanceof Node && !gesture.root.contains(event.target)) stopGesture()
  }, options)
  document.addEventListener('scroll', event => {
    if (gesture && !gesture.blocked && event.target === gesture.root) refreshFocus(gesture.pointer, false)
  }, options)
  window.addEventListener('blur', stopGesture, { signal: listeners.signal })
}

/** 借用已渲染的公开文字节点；释放时撤销注册，不替换TextLayer或原始文字数据。 */
export function attachTextSelection(layer: HTMLElement, textDivs: readonly HTMLElement[], root: HTMLDivElement): () => void {
  const adjacentTextDivs = new Map<HTMLElement, readonly HTMLElement[]>()
  textDivs.forEach((element, index) => {
    adjacentTextDivs.set(element, textDivs.slice(Math.max(0, index - 1), index + 2).filter(candidate => candidate !== element))
  })
  layers.set(layer, { root, textDivs: new Set(textDivs), adjacentTextDivs })
  installListeners()
  if (gesture && !gesture.blocked && gesture.root === root) refreshFocus(gesture.pointer, false)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (gesture?.origin === layer || (gesture?.lastText && layer.contains(gesture.lastText))) stopGesture()
    layers.delete(layer)
    if (layers.size === 0) { stopGesture(); listeners?.abort(); listeners = null; pointerType = 'mouse' }
  }
}

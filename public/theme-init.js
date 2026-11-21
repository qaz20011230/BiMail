/* 在首屏渲染前应用主题，避免闪烁；不读取任何远端数据。 */
(function () {
  try {
    var key = 'bimail.theme'
    var saved = localStorage.getItem(key)
    var theme = saved === 'dark' || saved === 'light'
      ? saved
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    var root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = theme
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#101214' : '#ffffff')
  } catch (error) {
    /* 存储或 matchMedia 不可用时保持默认亮色 */
  }
})()

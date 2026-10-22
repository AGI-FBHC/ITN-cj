// 一个小脚本，用来试 find / grep / read / edit
function renderList(items) {
  // TODO: 空列表时给个空状态提示
  return items.map((it) => "<li>" + it.title + "</li>").join("");
}

const DONE = ["读完第一章", "写了三要素笔记"];
export { renderList, DONE };

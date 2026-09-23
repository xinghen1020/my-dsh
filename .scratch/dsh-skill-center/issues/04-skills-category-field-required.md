# 04 — `skills.category` 缺字段时静默取消归类

Status: ready-for-agent
Severity: Optional
Area: `lib/index.js`

## 现象

`lib/index.js:334-339`：
```js
case 'skills.category': {
  const names = await knownNames(body, host)
  const categoryId = body.categoryId ?? null
  await host.store.setCategory(names, categoryId)
```
`store.setCategory` 把 `null` **和** `undefined` 一视同仁当作「落到未分类」（`lib/store.js:117-125`：`if (categoryId === null || categoryId === undefined) delete record.categoryId`）。于是字段缺失、字段名拼错（`category`）、客户端升级错位——都会变成一次**静默的批量取消归类**，返回 200，没有任何提示。

README:206 把该 action 的参数写成 `categoryId: string | null`；「null 明确表示未分类」与「字段没传」应当是两件事。

## 影响

不可逆的整理信息丢失（用户得多选一次再归回去），且是静默的——正是那种「什么都没发生但又不对」的故障。当前 client 永远显式传 `categoryId`（`client.js:950/1160/1447`），所以这不是线上 bug，而是**契约缺口**：任何第三方调用方或后续客户端改动都会踩到。

## 修法

`case 'skills.category'` 里显式区分两者：

```js
if (!Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
  throw new RequestError(400, '"categoryId" is required (use null for uncategorized)')
}
const categoryId = body.categoryId ?? null
if (categoryId !== null && typeof categoryId !== 'string') {
  throw new RequestError(400, '"categoryId" must be a string or null')
}
```

顺带把 `skills.enabled` 的 `enabled`（已是严格 boolean，`lib/index.js:330`）保持现状即可——它已经校验了。

## 验收

- 新测试：省略 `categoryId` → 400，且 `state.json` 里该技能的 `categoryId` 不变。
- 传 `categoryId: null` → 200，落到未分类（现有语义不变）。
- README:206 的表格补一句「字段必须出现，`null` 表示未分类」。

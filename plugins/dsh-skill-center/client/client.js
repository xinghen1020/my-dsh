/**
 * dsh-skill-center — browser half.
 *
 * Hand-written client bundle in the harness's `__ModuleLoader__` contract: the
 * host serves this file under `/plugins` and executes it once, which only
 * registers a factory; module side effects run when the plugin materializes.
 * `require` resolves against the shell's frozen platform table, so react,
 * react-dom and the UI primitives arrive from the host rather than from a
 * bundled copy — which is also why this file needs no build step.
 *
 * The panel follows the shape of Edge's favourites manager, because that is the
 * interaction users already know for a folder tree over a list:
 *
 *   title bar   [pane toggle]  title        [search] [refresh] [close]
 *   left pane   the category tree, folders only, expandable, drag targets
 *   right pane  the selected category's direct children — sub-folders as folder
 *               rows, skills as rows with a checkbox, an enable switch, and an
 *               uninstall button
 *   selection   checkboxes turn the toolbar into a batch bar
 *   search      leaves the tree selection behind and lists matches library-wide
 *
 * The tree itself is owned by the host half; this file renders what it is given
 * and sends one mutation per user gesture.
 *
 * Two seats are filled:
 *
 * - `sidebar.footer.action` — the sidebar's foot renders this list *before*
 *   `sidebar.settings`, so the entry sits directly above Settings.
 * - `shell.overlay` — the layout's root-level additive list, where the panel
 *   lives so it escapes the sidebar's 56px rail geometry entirely.
 *
 * Both share one open-state signal held in this factory's closure.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-center',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-skill-center'

    /** Same-origin host API. */
    const API = '/dsh-skill-center/api'

    /**
     * Style tag id. The shell injects plugin CSS with the same guard, so a
     * hot-reloaded bundle replaces its own tag instead of stacking copies.
     */
    const STYLE_ID = 'dsh-skill-center/styles'

    /** Sentinel for the fixed uncategorized container (it has no id of its own). */
    const UNCATEGORIZED = '__uncategorized__'

    const CSS = `
/* The sidebar foot lays footer actions out in a single nowrap flex row, so an
   entry that claims the full row width (dsh-context's does) squeezes every
   later entry to nothing. Wrapping the row lets each full-width entry take its
   own line instead. The shell's container class is build-hashed, so the
   container is addressed structurally through the outlet anchor the renderer
   gives every slot — a stable, unhashed data attribute. */
div:has(> div[data-slot="sidebar.footer.action"]){flex-wrap:wrap}
/* Geometry mirrors the entry already sitting in this seat, so both rows are
   the same height and share the sidebar's inline padding. */
.dsc-trigger{box-sizing:border-box;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dsc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-trigger:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}
.dsc-triggerRail{border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.dsc-triggerIcon{flex:none}
.dsc-triggerLabel{text-align:left;white-space:nowrap;text-overflow:ellipsis;flex:auto;min-width:0;overflow:hidden}
.dsc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}
.dsc-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsc-panel{position:relative;z-index:1;display:flex;flex-direction:column;width:980px;max-width:calc(100vw - 48px);height:min(760px, 100vh - 48px);border-radius:28px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);overflow:hidden;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsc-iconBtn{cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary)}
.dsc-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-iconBtn:disabled{opacity:.5;cursor:default}
.dsc-titlebar{display:flex;align-items:center;gap:10px;flex:none;padding:16px 14px 12px 18px}
.dsc-titlebarTitle{flex:1;min-width:0;font-size:16px;font-weight:500;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-search{box-sizing:border-box;flex:none;width:240px;height:32px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:inherit;font-family:inherit;font-size:13px;padding:0 10px}
.dsc-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsc-close{cursor:pointer;flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary)}
.dsc-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-main{display:flex;flex:1;min-height:0}
.dsc-treePane{flex:none;width:236px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}
.dsc-treePanelHidden{display:none}
.dsc-tree{flex:1;min-height:0;overflow:auto;padding:2px 8px 8px}
.dsc-treeRow{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:6px;height:32px;padding:0 6px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;text-align:left;cursor:pointer;user-select:none}
.dsc-treeRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-treeRowActive{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}
.dsc-treeRowDrop{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsc-treeRowDragging{opacity:.45}
.dsc-treeRowLocked{opacity:.35;cursor:no-drop}
.dsc-chevron{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border:0;background:0 0;padding:0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsc-chevronSpacer{flex:none;width:16px;height:16px}
.dsc-treeIcon{flex:none;display:flex;align-items:center}
.dsc-treeLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-preview{flex:none;min-height:30px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-content{flex:1;min-width:0;display:flex;flex-direction:column}
.dsc-contentHead{display:flex;align-items:center;gap:8px;flex:none;padding:0 18px 10px 18px}
.dsc-contentTitle{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-toolbar{display:flex;align-items:center;gap:6px;flex:none}
.dsc-selbar{display:flex;align-items:center;gap:6px;flex:none;padding:8px 18px;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsc-selCount{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-list{flex:1;min-height:0;overflow:auto;padding:0 12px 12px}
.dsc-row{display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:12px}
.dsc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-rowDrop{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsc-check{flex:none;width:14px;height:14px;margin:5px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dsc-rowIcon{flex:none;display:flex;align-items:center;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dsc-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsc-rowName{font-size:14px;font-weight:500;line-height:22px;word-break:break-all}
.dsc-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsc-rowMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsc-rowAside{flex:none;display:flex;align-items:center;gap:4px;margin-top:1px}
.dsc-folderName{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;word-break:break-all}
.dsc-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:10px;cursor:pointer;background:var(--dsw-alias-border-l3);transition:background .15s ease}
.dsc-switchOn{background:var(--dsw-alias-brand-primary)}
.dsc-switch:disabled{opacity:.5;cursor:default}
.dsc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsc-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .15s ease}
.dsc-switchOn .dsc-knob{transform:translateX(16px)}
.dsc-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:64px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}
.dsc-error{color:var(--dsw-alias-state-error-primary)}
.dsc-warnText{color:var(--dsw-alias-state-warn-primary)}
.dsc-detail{max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-all}
.dsc-spin{animation:dsc-spin 1s linear infinite}
@keyframes dsc-spin{to{transform:rotate(360deg)}}
.dsc-footer{display:flex;align-items:center;gap:12px;flex:none;padding:10px 18px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsc-stat{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-notice{flex:none;max-width:46%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-menu{position:fixed;z-index:1010;min-width:168px;display:flex;flex-direction:column;gap:1px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dsc-menuItem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsc-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-menuDanger{color:var(--dsw-alias-state-error-primary)}
.dsc-danger{color:var(--dsw-alias-state-error-primary)}
.dsc-dialogMask{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-2)}
.dsc-dialog{box-sizing:border-box;width:520px;max-width:calc(100% - 48px);max-height:calc(100% - 40px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:18px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.dsc-dialogTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dsc-dialogText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsc-field{display:flex;flex-direction:column;gap:6px}
.dsc-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsc-input{box-sizing:border-box;width:100%;height:32px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:inherit;font-family:inherit;font-size:13px;padding:0 10px}
.dsc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsc-textarea{height:auto;min-height:132px;resize:vertical;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:19px}
.dsc-dialogError{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
.dsc-dialogWide{width:640px;height:min(700px, calc(100% - 32px))}
.dsc-sourceBody{flex:1;min-height:110px;display:flex;flex-direction:column;gap:6px}
.dsc-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsc-chip{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsc-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-chipActive{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active);font-weight:500}
.dsc-chip:disabled{opacity:.45;cursor:default}
.dsc-chipMeta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsc-sourceList{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.dsc-sourceBody .dsc-sourceList{flex:1;min-height:0;max-height:none}
.dsc-stateInline{padding:16px;font-size:12px}
.dsc-sourceRow{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px;font-size:13px;line-height:18px}
.dsc-sourceRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-sourceRowTaken{opacity:.5}
.dsc-sourceName{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsc-sourceDesc{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-badge{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsc-pathRow{display:flex;align-items:center;gap:6px}
.dsc-pathRow .dsc-input{flex:1;min-width:0}
.dsc-pathText{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsc-result{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsc-dialogActions{display:flex;justify-content:flex-end;gap:8px}
.dsc-targetList{max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.dsc-targetRow{display:flex;align-items:center;gap:8px;padding:7px 10px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsc-targetRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-targetRowActive{background:var(--dsw-alias-interactive-bg-active);font-weight:500}
.dsc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
`

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      nav: '技能中心',
      title: '技能中心',
      close: '关闭',
      search: '搜索技能',
      refresh: '刷新',
      enabled: '已启用',
      disabled: '已停用',
      enable: '启用',
      disable: '停用',
      loading: '正在读取技能库…',
      errorTitle: '无法读取技能库',
      retry: '重试',
      empty: '技能库为空',
      noMatch: '没有匹配的技能',
      library: '技能库',
      warnings: '条警告',
      uncategorized: '未分类',
      root: '顶级',
      moveToRoot: '移到顶级',
      moveCategoryTitle: '把分类移动到…',
      moveCategoryHint: '选择新的上级；顶级表示不放在任何分类里。',
      alreadyChild: '它已经在这个分类下了',
      lockedTarget: '不能放进去：分类不能装进它自己或它的子分类里',
      dragCategoryHint: '正在拖动分类 —— 放到另一个分类上，它就成为该分类的子分类',
      dragSkillHint: '正在拖动技能 —— 放到分类或「未分类」上即归类',
      newSkill: '新建技能',
      newCategory: '新建分类',
      newSubcategory: '新建子分类',
      more: '更多',
      expandAll: '展开全部',
      collapseAll: '折叠全部',
      hideTree: '隐藏分类栏',
      showTree: '显示分类栏',
      rename: '重命名',
      delete: '删除分类',
      uninstall: '卸载',
      moveTo: '移动到…',
      selected: '已选',
      clearSelection: '取消选择',
      selectAll: '全选',
      noSkillsHere: '这个分类里还没有技能',
      noCategories: '还没有分类，先新建一个',
      results: '项结果',
      categoryName: '分类名称',
      skillName: '技能名称',
      skillDescription: '描述',
      skillBody: '正文（Markdown，可留空）',
      whereLabel: '归入分类',
      nameRequired: '名称不能为空',
      moveTitle: '移动到分类',
      moveHint: '选择目标分类；未分类表示不属于任何分类。',
      create: '创建',
      cancel: '取消',
      confirm: '确定',
      uninstallTitle: '卸载技能',
      uninstallBody: '将从技能库中删除下面的技能，此操作不可逆：',
      andMore: '等',
      items: '项',
      deleteCategoryTitle: '删除分类',
      deleteCategoryBody: '将删除该分类及其全部子分类。其中的技能会回落到「未分类」，技能本身不会被删除。',
      dragHint: '提示：把技能行拖到左侧分类即可归类',
      previewCategory: '分类',
      previewSkill: '技能',
      dropHere: '放到这里',
      importAction: '导入',
      importTitle: '从其他目录导入技能',
      importSource: '来源',
      importSkills: '技能',
      importNone: '这个来源里没有可导入的技能',
      importMissing: '目录不存在',
      importTruncated: '目录太大，结果已截断',
      importInvalid: '条无法导入',
      importTaken: '已存在',
      importOverwrite: '覆盖同名技能（会替换库里的副本）',
      importSelected: '已选',
      importSelectAll: '全选',
      importClearAll: '清空',
      importAddSource: '添加来源目录',
      importAddPlaceholder: '绝对路径，例如 D:/work/.claude/skills',
      importAdd: '添加',
      importRemoveSource: '移除来源',
      importNothing: '还没有选中任何技能',
      importResult: '已导入',
      importSkipped: '已跳过',
      importFailed: '导入失败：',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      nav: 'Skill Center',
      title: 'Skill Center',
      close: 'Close',
      search: 'Search skills',
      refresh: 'Refresh',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      loading: 'Reading the skill library…',
      errorTitle: 'Cannot read the skill library',
      retry: 'Retry',
      empty: 'The skill library is empty',
      noMatch: 'No skills match',
      library: 'Library',
      warnings: 'warning(s)',
      uncategorized: 'Uncategorized',
      root: 'Top level',
      moveToRoot: 'Move to top level',
      moveCategoryTitle: 'Move folder to…',
      moveCategoryHint: 'Pick the new parent. Top level means it sits in no folder.',
      alreadyChild: 'It is already in this folder',
      lockedTarget: 'Cannot go there: a folder cannot contain itself or its own subfolders',
      dragCategoryHint: 'Dragging a folder — drop it on another folder to make it a subfolder',
      dragSkillHint: 'Dragging a skill — drop it on a folder (or Uncategorized) to file it',
      newSkill: 'New skill',
      newCategory: 'New folder',
      newSubcategory: 'New subfolder',
      more: 'More',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      hideTree: 'Hide folders',
      showTree: 'Show folders',
      rename: 'Rename',
      delete: 'Delete folder',
      uninstall: 'Uninstall',
      moveTo: 'Move to…',
      selected: 'Selected',
      clearSelection: 'Clear selection',
      selectAll: 'Select all',
      noSkillsHere: 'No skills in this folder yet',
      noCategories: 'No folders yet — create one',
      results: 'result(s)',
      categoryName: 'Folder name',
      skillName: 'Skill name',
      skillDescription: 'Description',
      skillBody: 'Body (Markdown, optional)',
      whereLabel: 'Folder',
      nameRequired: 'A name is required',
      moveTitle: 'Move to folder',
      moveHint: 'Pick a target folder. Uncategorized means no folder at all.',
      create: 'Create',
      cancel: 'Cancel',
      confirm: 'Confirm',
      uninstallTitle: 'Uninstall skills',
      uninstallBody: 'These skills will be deleted from the library. This cannot be undone:',
      andMore: 'and',
      items: 'more',
      deleteCategoryTitle: 'Delete folder',
      deleteCategoryBody: 'This deletes the folder and every subfolder. Skills inside fall back to Uncategorized; the skills themselves are not deleted.',
      dragHint: 'Tip: drag a skill row onto a folder on the left to file it',
      previewCategory: 'Folder',
      previewSkill: 'Skill',
      dropHere: 'Drop here',
      importAction: 'Import',
      importTitle: 'Import skills from another directory',
      importSource: 'Source',
      importSkills: 'Skills',
      importNone: 'No importable skills in this source',
      importMissing: 'Directory not found',
      importTruncated: 'Directory is large — the result was truncated',
      importInvalid: 'unusable',
      importTaken: 'already here',
      importOverwrite: 'Replace skills that are already in the library',
      importSelected: 'Selected',
      importSelectAll: 'Select all',
      importClearAll: 'Clear',
      importAddSource: 'Add a source directory',
      importAddPlaceholder: 'Absolute path, e.g. D:/work/.claude/skills',
      importAdd: 'Add',
      importRemoveSource: 'Remove source',
      importNothing: 'Nothing is selected yet',
      importResult: 'Imported',
      importSkipped: 'Skipped',
      importFailed: 'Import failed: ',
    }

    /** Services this plugin needs from the client runtime. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries, styles, and both seats.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-center: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-skill-center'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'dsh-skill-center: styles')

      const t = ctx.locale.bind(NS)

      // One signal for both seats: the footer entry opens, the overlay panel
      // renders. Held here rather than in a slot store because neither seat
      // needs the value to survive this plugin's own lifetime.
      const openSignal = createSignal(false)

      /**
       * Trigger: the sidebar-foot entry, rendered directly above the sibling
       * entry that shares this seat.
       *
       * No `Tooltip` here on purpose. The seat is a flex row whose items are
       * sized by their own width, and Tooltip injects a wrapper around its
       * anchor; the native `title` the sibling entry already uses gives the
       * rail a hover hint without touching the box the row measures.
       */
      function Trigger(props) {
        const wide = props.wide === true
        const open = useSignal(openSignal)
        const label = props.t('nav')
        return h(
          'button',
          {
            type: 'button',
            className: wide ? 'dsc-trigger' : 'dsc-trigger dsc-triggerRail',
            title: label,
            'aria-label': label,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              openSignal.set(true)
            },
          },
          h(P.IconSkillOutline16, { size: wide ? 16 : 18, className: 'dsc-triggerIcon' }),
          wide ? h('span', { className: 'dsc-triggerLabel' }, label) : null,
        )
      }

      /** Panel: the favourites-style manager, portalled out of the sidebar. */
      function Panel(props) {
        const open = useSignal(openSignal)
        const [view, setView] = React.useState({ phase: 'idle', libraryDir: '', categories: [], skills: [], warnings: [], error: null })
        const [query, setQuery] = React.useState('')
        const [selectedId, setSelectedId] = React.useState(UNCATEGORIZED)
        const [collapsed, setCollapsed] = React.useState({})
        const [checked, setChecked] = React.useState(() => new Set())
        const [busy, setBusy] = React.useState(() => new Set())
        const [imports, setImports] = React.useState({ phase: 'idle', sources: [], error: null })
        const [treeOpen, setTreeOpen] = React.useState(true)
        const [preview, setPreview] = React.useState(null)
        const [menu, setMenu] = React.useState(null)
        const [dialog, setDialog] = React.useState(null)
        const [dropTarget, setDropTarget] = React.useState(null)
        const [dragState, setDragState] = React.useState(null)
        const [notice, setNotice] = React.useState(null)
        const dragPayload = React.useRef(null)
        const closeRef = React.useRef(null)

        const apply_payload = React.useCallback((payload) => {
          setView({
            phase: 'ready',
            libraryDir: payload.libraryDir ?? '',
            categories: payload.categories ?? [],
            skills: payload.skills ?? [],
            warnings: payload.warnings ?? [],
            error: null,
          })
        }, [])

        const load = React.useCallback(async () => {
          setView((prev) => ({ ...prev, phase: 'loading', error: null }))
          try {
            const payload = await readJson(await fetch(`${API}/library`, { headers: { accept: 'application/json' } }))
            apply_payload(payload)
          } catch (error) {
            setView((prev) => ({ ...prev, phase: 'error', error: messageOf(error) }))
          }
        }, [apply_payload])

        /**
         * Send one command and fold the returned snapshot back into the view.
         * @param action - command name.
         * @param extra - command payload.
         * @param options - names to mark busy, and whether to clear the selection.
         * @returns `{ ok: true, payload }`, or `{ ok: false, error }`. Returning
         *   the outcome lets a dialog stay open and show the reason next to the
         *   input that caused it, and lets the import dialog report what it did.
         */
        const mutate = React.useCallback(
          async (action, extra, options = {}) => {
            const names = options.names ?? []
            if (names.length > 0) setBusy((prev) => new Set([...prev, ...names]))
            try {
              const payload = await readJson(
                await fetch(`${API}/mutate`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action, ...extra }),
                }),
              )
              apply_payload(payload)
              if (options.clearSelection === true) setChecked(new Set())
              return { ok: true, payload }
            } catch (error) {
              const message = messageOf(error)
              setView((prev) => ({ ...prev, error: message }))
              return { ok: false, error: message }
            } finally {
              if (names.length > 0) {
                setBusy((prev) => {
                  const next = new Set(prev)
                  for (const name of names) next.delete(name)
                  return next
                })
              }
            }
          },
          [apply_payload],
        )

        /**
         * Refresh the import sources and everything they hold.
         *
         * Scanned on demand rather than kept in the snapshot: a source is
         * somebody else's directory, and the only moment its contents matter is
         * while the import dialog is open.
         */
        const loadSources = React.useCallback(async () => {
          setImports((prev) => ({ ...prev, phase: 'loading', error: null }))
          try {
            const payload = await readJson(await fetch(`${API}/sources`, { headers: { accept: 'application/json' } }))
            setImports({ phase: 'ready', sources: payload.sources ?? [], error: null })
          } catch (error) {
            setImports((prev) => ({ ...prev, phase: 'error', error: messageOf(error) }))
          }
        }, [])

        React.useEffect(() => {
          if (open) void load()
        }, [open, load])

        // Escape unwinds one layer at a time: dialog, then menu, then panel.
        React.useEffect(() => {
          if (!open) return undefined
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            if (dialog !== null) setDialog(null)
            else if (menu !== null) setMenu(null)
            else openSignal.set(false)
          }
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open, dialog, menu])

        React.useEffect(() => {
          if (!open) return undefined
          if (menu === null) return undefined
          const closeMenu = () => setMenu(null)
          document.addEventListener('pointerdown', closeMenu)
          window.addEventListener('resize', closeMenu)
          return () => {
            document.removeEventListener('pointerdown', closeMenu)
            window.removeEventListener('resize', closeMenu)
          }
        }, [open, menu])

        React.useEffect(() => {
          if (open) closeRef.current?.focus()
        }, [open])

        if (!open) return null

        const t = props.t
        const query_ = query.trim().toLowerCase()
        const searching = query_ !== ''
        const { categories, skills } = view
        const current = findNode(categories, selectedId)
        const searchHits = searching
          ? {
              categories: flattenTree(categories).filter((node) => node.name.toLowerCase().includes(query_)),
              skills: skills.filter(
                (skill) => skill.name.toLowerCase().includes(query_) || String(skill.description ?? '').toLowerCase().includes(query_),
              ),
            }
          : null

        const childFolders = searching === false && selectedId !== UNCATEGORIZED && current !== null ? current.children : []
        const listed = searching === true ? searchHits.skills : skills.filter((skill) => (skill.categoryId ?? null) === (selectedId === UNCATEGORIZED ? null : selectedId))
        const enabledCount = skills.filter((skill) => skill.enabled).length
        const selectedNames = [...checked]
        const busyAny = busy.size > 0

        /**
         * Folders that cannot receive the folder currently being dragged: itself
         * and its own subtree. Showing them as non-targets is what makes the
         * rule ("a folder cannot contain itself") visible instead of leaving a
         * refused drop to look like a broken one.
         */
        const draggedNode = dragState?.kind === 'category' ? findNode(categories, dragState.id) : null
        const lockedTargets = new Set(draggedNode === null ? [] : subtreeIds(draggedNode))

        const close = () => {
          openSignal.set(false)
          setMenu(null)
          setDialog(null)
          setChecked(new Set())
        }

        /** Current folder title, for the pane header. */
        const heading = searching
          ? `${t('search')}: ${query.trim()}`
          : selectedId === UNCATEGORIZED
            ? t('uncategorized')
            : (current?.name ?? t('uncategorized'))

        /**
         * Where "new skill" files by default: the folder being viewed.
         *
         * Declared here, above the render return, because the toolbar's click
         * handler closes over it — anything declared after the return would sit
         * in the temporal dead zone the first time that handler ran.
         */
        const defaultCategoryId = searching || selectedId === UNCATEGORIZED ? UNCATEGORIZED : selectedId

        const dialogHost = dialog === null ? null : renderDialog({ dialog, setDialog, mutate, view, t, imports, loadSources })
        const menuHost =
          menu === null
            ? null
            : h(
                'div',
                {
                  className: 'dsc-menu',
                  style: { left: `${menu.x}px`, top: `${menu.y}px` },
                  role: 'menu',
                  onPointerDown: (event) => event.stopPropagation(),
                },
                menu.items.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      role: 'menuitem',
                      className: item.danger === true ? 'dsc-menuItem dsc-menuDanger' : 'dsc-menuItem',
                      onClick: () => {
                        setMenu(null)
                        item.run()
                      },
                    },
                    item.label,
                  ),
                ),
              )

        const panel = h(
          'div',
          { className: 'dsc-overlay', role: 'presentation' },
          h('div', { className: 'dsc-mask', 'aria-hidden': 'true', onClick: close }),
          h(
            'div',
            { className: 'dsc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
            h(
              'div',
              { className: 'dsc-titlebar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-iconBtn',
                  style: { width: '28px', height: '28px' },
                  title: treeOpen ? t('hideTree') : t('showTree'),
                  'aria-label': treeOpen ? t('hideTree') : t('showTree'),
                  'aria-pressed': treeOpen ? 'true' : 'false',
                  onClick: () => {
                    setTreeOpen((value) => !value)
                  },
                },
                h(P.IconPanelLeftOutline16, { size: 16 }),
              ),
              h('div', { className: 'dsc-titlebarTitle' }, t('title')),
              h('input', {
                className: 'dsc-search',
                type: 'search',
                value: query,
                placeholder: t('search'),
                'aria-label': t('search'),
                onChange: (event) => {
                  setQuery(event.target.value)
                },
              }),
              h(
                P.Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  icon: h(P.IconRefreshOutline16, { size: 14 }),
                  disabled: view.phase === 'loading',
                  onClick: () => {
                    void load()
                  },
                },
                t('refresh'),
              ),
              h(
                'button',
                { type: 'button', ref: closeRef, className: 'dsc-close', 'aria-label': t('close'), onClick: close },
                h(P.IconCloseOutline16, { size: 14 }),
              ),
            ),
            h(
              'div',
              { className: 'dsc-main' },
              h(
                'div',
                { className: treeOpen ? 'dsc-treePane' : 'dsc-treePane dsc-treePanelHidden' },
                h('div', { className: 'dsc-tree', role: 'tree', 'aria-label': t('title') }, renderTree()),
                h('div', { className: 'dsc-preview' }, dragState === null ? previewText(preview, t) : t(dragState.kind === 'category' ? 'dragCategoryHint' : 'dragSkillHint')),
              ),
              h(
                'div',
                { className: 'dsc-content' },
                h(
                  'div',
                  { className: 'dsc-contentHead' },
                  h('h2', { className: 'dsc-contentTitle', title: heading }, heading),
                  renderToolbar(),
                ),
                // The batch bar is permanent: it is the only place the batch
                // actions live, so hiding it until something is checked would
                // make the actions discoverable only by accident.
                renderSelectionBar(),
                h('div', { className: 'dsc-list' }, renderList()),
              ),
            ),
            h(
              'div',
              { className: 'dsc-footer' },
              h('div', { className: 'dsc-stat', title: view.libraryDir }, `${t('enabled')} ${enabledCount}/${skills.length}`),
              notice === null ? null : h('div', { className: 'dsc-notice', title: notice }, notice),
              view.error === null ? null : h('div', { className: 'dsc-stat dsc-error' }, view.error),
              view.warnings.length === 0
                ? null
                : h('div', { className: 'dsc-stat dsc-warnText', title: view.warnings.join('\n') }, `${view.warnings.length} ${t('warnings')}`),
            ),
            dialogHost,
          ),
          menuHost,
        )

        return ReactDOM.createPortal(panel, document.body)

        // ------------------------------------------------------------ render

        /** The page-level toolbar, shown whenever nothing is selected. */
        function renderToolbar() {
          return h(
            'div',
            { className: 'dsc-toolbar' },
            h(
              P.Button,
              {
                variant: 'outline',
                size: 'sm',
                icon: h(P.IconPlusOutline16, { size: 14 }),
                onClick: () => {
                  setDialog({ kind: 'create-skill', name: '', description: '', body: '', categoryId: defaultCategoryId })
                },
              },
              t('newSkill'),
            ),
            h(
              P.Button,
              {
                variant: 'outline',
                size: 'sm',
                icon: h(P.IconFolderOpen16, { size: 14 }),
                onClick: () => {
                  setDialog({ kind: 'create-category', parentId: newCategoryParent() })
                },
              },
              t('newCategory'),
            ),
            h(
              P.Button,
              {
                variant: 'outline',
                size: 'sm',
                icon: h(P.IconDownloadOutline16, { size: 14 }),
                onClick: () => {
                  setDialog({ kind: 'import', sourceId: null, names: [], overwrite: false, categoryId: defaultCategoryId, result: null, error: null })
                  void loadSources()
                },
              },
              t('importAction'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsc-iconBtn',
                style: { width: '28px', height: '28px' },
                title: t('more'),
                'aria-label': t('more'),
                onClick: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMenu({ x: Math.max(8, rect.right - 168), y: rect.bottom + 6, items: moreItems() })
                },
              },
              h(P.IconEllipsisOutline16, { size: 16 }),
            ),
          )
        }

        /** Where "new folder" creates: inside the selected folder, else top level. */
        function newCategoryParent() {
          if (searching || selectedId === UNCATEGORIZED || current === null) return null
          return selectedId
        }

        /** Items offered by the overflow menu. */
        function moreItems() {
          const items = [
            {
              id: 'expand',
              label: t('expandAll'),
              run: () => {
                setCollapsed({})
              },
            },
            {
              id: 'collapse',
              label: t('collapseAll'),
              run: () => {
                const next = {}
                for (const node of flattenTree(categories)) next[node.id] = true
                setCollapsed(next)
              },
            },
          ]
          if (searching === false && selectedId !== UNCATEGORIZED && current !== null) {
            items.push(
              { id: 'sub', label: t('newSubcategory'), run: () => setDialog({ kind: 'create-category', parentId: selectedId }) },
              { id: 'rename', label: t('rename'), run: () => setDialog({ kind: 'rename-category', id: selectedId, name: current.name }) },
              { id: 'delete', label: t('delete'), danger: true, run: () => setDialog({ kind: 'delete-category', id: selectedId, name: current.name }) },
            )
          }
          return items
        }

        /**
         * The batch bar. Permanent, because these are the only entry points for
         * the batch actions — revealing them only once something is checked
         * makes them discoverable by accident alone. With nothing checked every
         * action is disabled rather than absent.
         */
        function renderSelectionBar() {
          const idle = busyAny || checked.size === 0
          /** Run a batch action only with a real selection behind it. */
          const batch = (run) => () => {
            if (checked.size === 0) return
            run()
          }
          return h(
            'div',
            { className: 'dsc-selbar' },
            h('div', { className: 'dsc-selCount' }, `${t('selected')} ${checked.size}`),
            h(
              P.Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: idle,
                onClick: batch(() => {
                  void mutate('skills.enabled', { names: selectedNames, enabled: true }, { names: selectedNames })
                }),
              },
              t('enable'),
            ),
            h(
              P.Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: idle,
                onClick: batch(() => {
                  void mutate('skills.enabled', { names: selectedNames, enabled: false }, { names: selectedNames })
                }),
              },
              t('disable'),
            ),
            h(
              P.Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: idle,
                onClick: batch(() => {
                  setDialog({ kind: 'move', names: selectedNames })
                }),
              },
              t('moveTo'),
            ),
            h(
              P.Button,
              {
                variant: 'ghost',
                size: 'sm',
                icon: h(P.IconTrashOutline16, { size: 14 }),
                disabled: idle,
                onClick: batch(() => {
                  setDialog({ kind: 'uninstall', names: selectedNames })
                }),
              },
              t('uninstall'),
            ),
            h(
              P.Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: idle,
                onClick: () => {
                  setChecked(new Set())
                },
              },
              t('clearSelection'),
            ),
          )
        }

        /** The left pane: 未分类 first, then the user's tree in order. */
        function renderTree() {
          const rows = [
            h(
              'button',
              {
                key: UNCATEGORIZED,
                type: 'button',
                role: 'treeitem',
                'aria-selected': selectedId === UNCATEGORIZED ? 'true' : 'false',
                className: cx(
                  'dsc-treeRow',
                  selectedId === UNCATEGORIZED && 'dsc-treeRowActive',
                  dropTarget === UNCATEGORIZED && 'dsc-treeRowDrop',
                  // 未分类 can hold skills but never a folder, so while a folder
                  // is being dragged it is not a target and must not look like one.
                  dragState?.kind === 'category' && 'dsc-treeRowLocked',
                ),
                onClick: () => {
                  setSelectedId(UNCATEGORIZED)
                },
                // Dropping a skill here means "take it out of its folder". The
                // container accepts skills only — it can never hold a
                // sub-folder — so a category drag gets no drop target at all
                // rather than a silently ignored one.
                onDragOver: (event) => {
                  if (dragPayload.current?.kind !== 'skills') return
                  event.preventDefault()
                  setDropTarget(UNCATEGORIZED)
                },
                onDragLeave: () => {
                  setDropTarget((value) => (value === UNCATEGORIZED ? null : value))
                },
                onDrop: (event) => {
                  event.preventDefault()
                  const payload = dragPayload.current
                  dragPayload.current = null
                  setDropTarget(null)
                  if (payload?.kind !== 'skills') return
                  void mutate('skills.category', { names: payload.names, categoryId: null }, { names: payload.names, clearSelection: true })
                },
                onMouseEnter: () => setPreview({ kind: 'uncategorized', name: t('uncategorized') }),
                onMouseLeave: () => setPreview(null),
              },
              h('span', { className: 'dsc-chevronSpacer' }),
              h('span', { className: 'dsc-treeIcon' }, h(P.IconFolderOpen16, { size: 16 })),
              h('span', { className: 'dsc-treeLabel' }, t('uncategorized')),
            ),
          ]
          for (const node of treeRows(categories, collapsed, 1)) {
            const isCollapsed = collapsed[node.id] === true
            rows.push(
              h(
                'div',
                {
                  key: node.id,
                  role: 'treeitem',
                  'aria-selected': selectedId === node.id ? 'true' : 'false',
                  'aria-expanded': node.hasChildren ? (isCollapsed ? 'false' : 'true') : undefined,
                  tabIndex: 0,
                  className: cx(
                    'dsc-treeRow',
                    selectedId === node.id && 'dsc-treeRowActive',
                    dropTarget === node.id && 'dsc-treeRowDrop',
                    dragState?.kind === 'category' && dragState.id === node.id && 'dsc-treeRowDragging',
                    dragState?.kind === 'category' && lockedTargets.has(node.id) && 'dsc-treeRowLocked',
                  ),
                  style: { paddingLeft: `${6 + (node.depth - 1) * 14}px` },
                  draggable: true,
                  onDragStart: (event) => {
                    dragPayload.current = { kind: 'category', id: node.id }
                    setDragState({ kind: 'category', id: node.id })
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', node.name)
                  },
                  onDragEnd: () => {
                    dragPayload.current = null
                    setDragState(null)
                    setDropTarget(null)
                  },
                  onDragOver: (event) => {
                    const payload = dragPayload.current
                    if (payload === null) return
                    // A folder cannot be dropped into itself or its own subtree;
                    // refusing the drop target (rather than accepting and then
                    // erroring) is what makes the rule visible.
                    if (payload.kind === 'category' && lockedTargets.has(node.id)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropTarget(node.id)
                  },
                  onDragLeave: () => {
                    setDropTarget((value) => (value === node.id ? null : value))
                  },
                  onDrop: (event) => {
                    event.preventDefault()
                    const payload = dragPayload.current
                    dragPayload.current = null
                    setDragState(null)
                    setDropTarget(null)
                    if (payload === null) return
                    if (payload.kind === 'skills') {
                      void mutate('skills.category', { names: payload.names, categoryId: node.id }, { names: payload.names, clearSelection: true })
                      return
                    }
                    if (payload.id === node.id || lockedTargets.has(node.id)) return
                    if (parentIdOf(categories, payload.id) === node.id) {
                      // Already a child of this folder: say so, because a drop
                      // that changes nothing otherwise reads as a broken drag.
                      setNotice(`${t('alreadyChild')}: ${node.name}`)
                      return
                    }
                    setNotice(null)
                    void mutate('categories.move', { id: payload.id, parentId: node.id })
                  },
                  onClick: () => {
                    setSelectedId(node.id)
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedId(node.id)
                    }
                  },
                  onMouseEnter: () => setPreview({ kind: 'category', name: node.name }),
                  onMouseLeave: () => setPreview(null),
                  onContextMenu: (event) => {
                    event.preventDefault()
                    const items = [
                      { id: 'sub', label: t('newSubcategory'), run: () => setDialog({ kind: 'create-category', parentId: node.id }) },
                      { id: 'rename', label: t('rename'), run: () => setDialog({ kind: 'rename-category', id: node.id, name: node.name }) },
                      // Dragging is the quick path; this is the one that always
                      // works, including on a tree too small to drag within.
                      { id: 'move', label: t('moveTo'), run: () => setDialog({ kind: 'move-category', id: node.id, name: node.name }) },
                    ]
                    // Nesting is otherwise a one-way door: the only drag target
                    // for a category is another category, which nests it deeper.
                    // A nested node gets an explicit way back to the top level.
                    if (isTopLevel(categories, node.id) === false) {
                      items.push({
                        id: 'toRoot',
                        label: t('moveToRoot'),
                        run: () => {
                          void mutate('categories.move', { id: node.id, parentId: null })
                        },
                      })
                    }
                    items.push({ id: 'delete', label: t('delete'), danger: true, run: () => setDialog({ kind: 'delete-category', id: node.id, name: node.name }) })
                    setMenu({ x: event.clientX, y: event.clientY, items })
                  },
                },
                node.hasChildren
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsc-chevron',
                        'aria-label': isCollapsed ? t('expandAll') : t('collapseAll'),
                        onClick: (event) => {
                          event.stopPropagation()
                          setCollapsed((prev) => ({ ...prev, [node.id]: prev[node.id] !== true }))
                        },
                      },
                      isCollapsed ? h(P.IconChevronRightOutline14, { size: 12 }) : h(P.IconChevronDownOutline14, { size: 12 }),
                    )
                  : h('span', { className: 'dsc-chevronSpacer' }),
                h('span', { className: 'dsc-treeIcon' }, h(P.IconFolderOpen16, { size: 16 })),
                h('span', { className: 'dsc-treeLabel' }, node.name),
              ),
            )
          }
          return rows
        }

        /** The right pane: folder rows first, then skill rows. */
        function renderList() {
          if (view.phase === 'loading' && skills.length === 0) {
            return h('div', { className: 'dsc-state' }, h(P.IconLoadingOutline16, { size: 18, className: 'dsc-spin' }), t('loading'))
          }
          if (view.phase === 'error' && skills.length === 0) {
            return h(
              'div',
              { className: 'dsc-state' },
              h(P.IconWarningOutline16, { size: 18 }),
              t('errorTitle'),
              h('div', { className: 'dsc-detail' }, view.error ?? ''),
              h(
                P.Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  icon: h(P.IconRefreshOutline16, { size: 14 }),
                  onClick: () => {
                    void load()
                  },
                },
                t('retry'),
              ),
            )
          }

          const showEmptyFolderHint = searching === false && selectedId !== UNCATEGORIZED && categories.length === 0
          if (showEmptyFolderHint) {
            return h('div', { className: 'dsc-state' }, h(P.IconFolderOpen16, { size: 18 }), t('noCategories'))
          }
          if (searching === false && listed.length === 0 && childFolders.length === 0) {
            return h(
              'div',
              { className: 'dsc-state' },
              h(P.IconSkillOutline16, { size: 18 }),
              skills.length === 0 ? t('empty') : t('noSkillsHere'),
            )
          }
          if (searching === true && listed.length === 0 && searchHits.categories.length === 0) {
            return h('div', { className: 'dsc-state' }, h(P.IconSkillOutline16, { size: 18 }), t('noMatch'))
          }

          const rows = []
          for (const folder of searching === true ? searchHits.categories : childFolders) {
            rows.push(renderFolderRow(folder))
          }
          for (const skill of listed) {
            rows.push(renderSkillRow(skill))
          }
          return rows
        }

        /** One sub-folder row: click navigates into it. */
        function renderFolderRow(folder) {
          return h(
            'div',
            {
              key: `folder:${folder.id}`,
              className: cx('dsc-row', dropTarget === folder.id && 'dsc-rowDrop'),
              onDragOver: (event) => {
                if (dragPayload.current === null) return
                event.preventDefault()
                setDropTarget(folder.id)
              },
              onDragLeave: () => {
                setDropTarget((value) => (value === folder.id ? null : value))
              },
              onDrop: (event) => {
                event.preventDefault()
                const payload = dragPayload.current
                dragPayload.current = null
                setDropTarget(null)
                if (payload === null) return
                if (payload.kind === 'skills') {
                  void mutate('skills.category', { names: payload.names, categoryId: folder.id }, { names: payload.names, clearSelection: true })
                } else if (payload.id !== folder.id) {
                  void mutate('categories.move', { id: payload.id, parentId: folder.id })
                }
              },
            },
            h('span', { className: 'dsc-rowIcon' }, h(P.IconFolderOpen16, { size: 16 })),
            h('div', { className: 'dsc-rowMain' }, h('div', { className: 'dsc-folderName' }, folder.name)),
            h(
              'div',
              { className: 'dsc-rowAside' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-iconBtn',
                  style: { width: '28px', height: '28px' },
                  title: t('rename'),
                  'aria-label': `${t('rename')}: ${folder.name}`,
                  onClick: () => setDialog({ kind: 'rename-category', id: folder.id, name: folder.name }),
                },
                h(P.IconEditOutline16, { size: 14 }),
              ),
            ),
          )
        }

        /** One skill row: checkbox, name, description, enable switch, uninstall. */
        function renderSkillRow(skill) {
          const isChecked = checked.has(skill.name)
          const isBusy = busy.has(skill.name)
          return h(
            'div',
            {
              key: `skill:${skill.name}`,
              className: 'dsc-row',
              draggable: true,
              onDragStart: (event) => {
                // Dragging a checked row carries the whole selection.
                const names = isChecked ? selectedNames : [skill.name]
                dragPayload.current = { kind: 'skills', names }
                setDragState({ kind: 'skills' })
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', names.join(', '))
              },
              onDragEnd: () => {
                dragPayload.current = null
                setDragState(null)
                setDropTarget(null)
              },
              onContextMenu: (event) => {
                event.preventDefault()
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { id: 'move', label: t('moveTo'), run: () => setDialog({ kind: 'move', names: isChecked ? selectedNames : [skill.name] }) },
                    {
                      id: 'toggle',
                      label: skill.enabled ? t('disable') : t('enable'),
                      run: () => {
                        void mutate('skills.enabled', { names: [skill.name], enabled: !skill.enabled }, { names: [skill.name] })
                      },
                    },
                    { id: 'uninstall', label: t('uninstall'), danger: true, run: () => setDialog({ kind: 'uninstall', names: [skill.name] }) },
                  ],
                })
              },
            },
            h('input', {
              className: 'dsc-check',
              type: 'checkbox',
              checked: isChecked,
              'aria-label': `${skill.name}`,
              onChange: () => {
                setChecked((prev) => {
                  const next = new Set(prev)
                  if (next.has(skill.name)) next.delete(skill.name)
                  else next.add(skill.name)
                  return next
                })
              },
            }),
            h('span', { className: 'dsc-rowIcon' }, h(P.IconSkillOutline16, { size: 16 })),
            h(
              'div',
              { className: 'dsc-rowMain' },
              h('div', { className: 'dsc-rowName' }, skill.name),
              h('div', { className: 'dsc-rowDesc' }, skill.description),
              h('div', { className: 'dsc-rowMeta' }, renderMeta(skill)),
            ),
            h(
              'div',
              { className: 'dsc-rowAside' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  className: skill.enabled ? 'dsc-switch dsc-switchOn' : 'dsc-switch',
                  'aria-checked': skill.enabled ? 'true' : 'false',
                  'aria-label': `${skill.enabled ? t('disable') : t('enable')}: ${skill.name}`,
                  disabled: isBusy,
                  onClick: () => {
                    void mutate('skills.enabled', { names: [skill.name], enabled: !skill.enabled }, { names: [skill.name] })
                  },
                },
                h('span', { className: 'dsc-knob' }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-iconBtn',
                  style: { width: '28px', height: '28px' },
                  title: t('uninstall'),
                  'aria-label': `${t('uninstall')}: ${skill.name}`,
                  disabled: isBusy,
                  onClick: () => setDialog({ kind: 'uninstall', names: [skill.name] }),
                },
                h(P.IconTrashOutline16, { size: 14 }),
              ),
            ),
          )
        }

        /** The status chips under a skill name. */
        function renderMeta(skill) {
          const meta = [h(P.StateDot, { key: 'dot', state: skill.enabled ? 'done' : 'warning', size: 8 }), h('span', { key: 'label' }, skill.enabled ? t('enabled') : t('disabled'))]
          // The invocation chips are deliberately not surfaced for now. The data
          // is still there — every row carries `modelInvocable` / `userInvocable`
          // from the host — so bringing them back is these two lines plus the
          // two dictionary keys:
          //
          //   if (skill.enabled && skill.modelInvocable === false) meta.push(h('span', { key: 'model' }, t('modelHidden')))
          //   if (skill.enabled && skill.userInvocable === false) meta.push(h('span', { key: 'user' }, t('userHidden')))
          if (searching === true) {
            const parent = findNode(categories, skill.categoryId)
            meta.push(h('span', { key: 'where' }, parent === null ? t('uncategorized') : parent.name))
          }
          return meta
        }
      }

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-skill-center',
            // Sorts before dsh-context's `context-overview` (order 10), so this
            // entry is the line directly above "上下文洞察"; the row wraps, so
            // the two do not fight over one line. Order, not registration
            // order, is the contract — it must not be left as a tie.
            order: 9,
            label: () => t('nav'),
            locale: NS,
          },
          Trigger,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-skill-center-panel',
            order: 40,
            label: () => t('title'),
            locale: NS,
          },
          Panel,
        ),
      )
    }

    // ------------------------------------------------------------------ dialog

    /**
     * Render whichever dialog is open.
     *
     * One shell for all five: they differ only in body and in what the primary
     * button sends, and the destructive ones must state plainly what they will
     * delete before the button is reachable.
     *
     * @param props - the dialog descriptor plus the actions it needs.
     * @returns the dialog element.
     */
    function renderDialog({ dialog, setDialog, mutate, view, t, imports, loadSources }) {
      const close = () => setDialog(null)
      /** Merge fields into the dialog descriptor, so the form stays controlled. */
      const patch = (fields) => setDialog((prev) => ({ ...prev, ...fields }))
      /** Run a command, and close only when it actually succeeded. */
      const submit = (command) => async () => {
        const result = await command()
        if (result.ok) close()
        else patch({ error: result.error })
      }
      const field = (label, control) => h('div', { className: 'dsc-field' }, h('label', { className: 'dsc-fieldLabel' }, label), control)
      const body = []
      let title = ''
      let primaryLabel = t('confirm')
      let danger = false
      let run = null

      if (dialog.kind === 'create-category' || dialog.kind === 'rename-category') {
        const isRename = dialog.kind === 'rename-category'
        const parentId = dialog.parentId ?? null
        title = isRename ? t('rename') : parentId === null ? t('newCategory') : t('newSubcategory')
        primaryLabel = isRename ? t('confirm') : t('create')
        const parent = parentId === null ? null : findNode(view.categories, parentId)
        run = submit(async () => {
          const name = String(dialog.name ?? '').trim()
          if (name === '') return { ok: false, error: t('nameRequired') }
          return await (isRename
            ? mutate('categories.rename', { id: dialog.id, name })
            : mutate('categories.create', { name, parentId }))
        })
        body.push(
          field(
            t('categoryName'),
            h(TextField, {
              value: dialog.name ?? '',
              placeholder: t('categoryName'),
              autoFocus: true,
              onChange: (value) => patch({ name: value }),
              onEnter: () => {
                void run()
              },
            }),
          ),
        )
        if (isRename === false && parent !== null) {
          body.push(h('div', { className: 'dsc-hint', key: 'where' }, `${t('previewCategory')}: ${parent.name}`))
        }
      } else if (dialog.kind === 'create-skill') {
        title = t('newSkill')
        primaryLabel = t('create')
        run = submit(async () => {
          const name = String(dialog.name ?? '').trim()
          if (name === '') return { ok: false, error: t('nameRequired') }
          const categoryId = dialog.categoryId ?? UNCATEGORIZED
          return await mutate('skills.create', {
            name,
            description: dialog.description ?? '',
            body: dialog.body ?? '',
            categoryId: categoryId === UNCATEGORIZED ? null : categoryId,
          })
        })
        body.push(
          field(
            t('skillName'),
            h(TextField, {
              value: dialog.name ?? '',
              placeholder: 'my-new-skill',
              autoFocus: true,
              onChange: (value) => patch({ name: value }),
            }),
          ),
        )
        body.push(
          field(
            t('skillDescription'),
            h(TextField, {
              value: dialog.description ?? '',
              onChange: (value) => patch({ description: value }),
            }),
          ),
        )
        body.push(
          field(
            t('skillBody'),
            h(TextField, {
              value: dialog.body ?? '',
              multiline: true,
              onChange: (value) => patch({ body: value }),
            }),
          ),
        )
        body.push(field(t('whereLabel'), h(TargetPicker, { categories: view.categories, t, value: dialog.categoryId ?? UNCATEGORIZED, onChange: (value) => patch({ categoryId: value }) })))
      } else if (dialog.kind === 'move') {
        title = t('moveTitle')
        primaryLabel = t('moveTo')
        body.push(h('div', { className: 'dsc-hint', key: 'hint' }, t('moveHint')))
        run = submit(async () => {
          const target = dialog.categoryId ?? UNCATEGORIZED
          return await mutate(
            'skills.category',
            { names: dialog.names, categoryId: target === UNCATEGORIZED ? null : target },
            { names: dialog.names, clearSelection: true },
          )
        })
        body.push(
          h(TargetPicker, {
            key: 'targets',
            categories: view.categories,
            t,
            value: dialog.categoryId ?? UNCATEGORIZED,
            onChange: (value) => patch({ categoryId: value }),
          }),
        )
      } else if (dialog.kind === 'move-category') {
        title = t('moveCategoryTitle')
        primaryLabel = t('moveTo')
        body.push(h('div', { className: 'dsc-hint', key: 'hint' }, t('moveCategoryHint')))
        // A folder may not be filed inside itself, so its own subtree is not
        // offered. Here the first option really is "top level", which is why it
        // is labelled that way instead of 未分类.
        const node = findNode(view.categories, dialog.id)
        const exclude = node === null ? [] : subtreeIds(node)
        run = submit(async () => {
          const target = dialog.categoryId ?? UNCATEGORIZED
          return await mutate('categories.move', { id: dialog.id, parentId: target === UNCATEGORIZED ? null : target })
        })
        body.push(
          h(TargetPicker, {
            key: 'targets',
            categories: view.categories,
            t,
            rootLabel: t('root'),
            exclude,
            value: dialog.categoryId ?? UNCATEGORIZED,
            onChange: (value) => patch({ categoryId: value }),
          }),
        )
      } else if (dialog.kind === 'delete-category') {
        title = t('deleteCategoryTitle')
        primaryLabel = t('delete')
        danger = true
        body.push(h('p', { className: 'dsc-dialogText', key: 'body' }, t('deleteCategoryBody')))
        body.push(h('p', { className: 'dsc-dialogText dsc-error', key: 'name' }, dialog.name))
        run = submit(async () => await mutate('categories.delete', { id: dialog.id }))
      } else if (dialog.kind === 'uninstall') {
        title = t('uninstallTitle')
        primaryLabel = t('uninstall')
        danger = true
        // Irreversible, so the names being deleted are always spelled out.
        const shown = dialog.names.slice(0, 8)
        const rest = dialog.names.length - shown.length
        body.push(h('p', { className: 'dsc-dialogText', key: 'body' }, t('uninstallBody')))
        body.push(
          h(
            'div',
            { className: 'dsc-dialogText', key: 'names' },
            shown.map((name) => h('div', { key: name }, name)),
            rest > 0 ? h('div', { key: 'rest' }, `${t('andMore')} ${rest} ${t('items')}`) : null,
          ),
        )
        body.push(h('p', { className: 'dsc-dialogText dsc-detail', key: 'where' }, view.libraryDir))
        run = submit(async () => await mutate('skills.uninstall', { names: dialog.names }, { names: dialog.names, clearSelection: true }))
      } else if (dialog.kind === 'import') {
        title = t('importTitle')
        primaryLabel = t('importAction')
        const sources = imports.sources ?? []
        const usable = sources.filter((source) => source.exists && source.skills.length > 0)
        const active = sources.find((source) => source.id === dialog.sourceId) ?? usable[0] ?? sources[0] ?? null
        const taken = active === null ? new Set() : new Set(active.skills.filter((skill) => skill.imported).map((skill) => skill.name))
        const selectable = active === null ? [] : active.skills.filter((skill) => dialog.overwrite === true || !skill.imported)
        const chosen = dialog.names ?? []
        const toggle = (name) => patch({ names: chosen.includes(name) ? chosen.filter((entry) => entry !== name) : [...chosen, name] })

        if (imports.phase === 'error') {
          body.push(h('div', { className: 'dsc-dialogError' }, imports.error ?? t('errorTitle')))
        }

        body.push(
          field(
            t('importSource'),
            h(
              'div',
              { className: 'dsc-chips' },
              [
                ...sources.map((source) =>
                  h(
                    'button',
                    {
                      key: source.id,
                      type: 'button',
                      disabled: !source.exists,
                      title: source.path,
                      className: source.id === active?.id ? 'dsc-chip dsc-chipActive' : 'dsc-chip',
                      onClick: () => {
                        patch({ sourceId: source.id, names: [], result: null, error: null })
                      },
                    },
                    source.label,
                    h('span', { className: 'dsc-chipMeta' }, source.exists ? String(source.skills.length) : t('importMissing')),
                  ),
                ),
                // The add control lives with the sources, not at the bottom of a
                // scrolling dialog where it is easy to never see.
                h(
                  'button',
                  {
                    key: '__add-source',
                    type: 'button',
                    className: dialog.adding === true ? 'dsc-chip dsc-chipActive' : 'dsc-chip',
                    onClick: () => patch({ adding: dialog.adding !== true, error: null }),
                  },
                  dialog.adding === true ? t('cancel') : `+ ${t('importAddSource')}`,
                ),
              ],
            ),
          ),
        )

        if (dialog.adding === true) {
          body.push(
            h(
              'div',
              { className: 'dsc-pathRow', key: 'add' },
              h(TextField, {
                value: dialog.newPath ?? '',
                placeholder: t('importAddPlaceholder'),
                autoFocus: true,
                onChange: (value) => patch({ newPath: value }),
                onEnter: () => {
                  void addSource()
                },
              }),
              h(
                P.Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: String(dialog.newPath ?? '').trim() === '',
                  onClick: () => {
                    void addSource()
                  },
                },
                t('importAdd'),
              ),
            ),
          )
        }

        /** Validate and remember a directory, then select it. */
        async function addSource() {
          const result = await mutate('sources.add', { path: String(dialog.newPath ?? '').trim() })
          if (!result.ok) {
            patch({ error: result.error })
            return
          }
          patch({ newPath: '', adding: false, sourceId: result.payload.addedSource, names: [], result: null, error: null })
          await loadSources()
        }

        if (active !== null && active.exists) {
          body.push(
            h(
              'div',
              { className: 'dsc-pathRow', key: 'path' },
              h('div', { className: 'dsc-pathText' }, active.path),
              // A source the user added is theirs to remove; the built-ins are not.
              active.custom
                ? h(
                    P.Button,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: async () => {
                        const result = await mutate('sources.remove', { id: active.id })
                        if (!result.ok) {
                          patch({ error: result.error })
                          return
                        }
                        patch({ sourceId: null, names: [], result: null, error: null })
                        await loadSources()
                      },
                    },
                    t('importRemoveSource'),
                  )
                : null,
            ),
          )
          // Everything whose length depends on the selected source lives inside
          // one flexible region, so switching sources scrolls this area instead
          // of resizing the dialog under the pointer.
          body.push(
            h(
              'div',
              { className: 'dsc-sourceBody', key: 'body' },
              dialog.result === null || dialog.result === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsc-result' },
                    `${t('importResult')} ${dialog.result.imported.length}`,
                    dialog.result.skipped.length === 0
                      ? ''
                      : ` · ${t('importSkipped')} ${dialog.result.skipped.length}: ${dialog.result.skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`,
                  ),
              active.truncated ? h('div', { className: 'dsc-hint' }, t('importTruncated')) : null,
              active.invalid.length > 0
                ? h('div', { className: 'dsc-hint' }, `${active.invalid.length} ${t('importInvalid')}: ${active.invalid[0].relative}`)
                : null,
              h(
                'div',
                { className: 'dsc-sourceList' },
                active.skills.length === 0
                  ? h('div', { className: 'dsc-state dsc-stateInline' }, t('importNone'))
                  : active.skills.map((skill) => {
                      const isTaken = taken.has(skill.name) && dialog.overwrite !== true
                      return h(
                        'label',
                        { key: skill.name, className: isTaken ? 'dsc-sourceRow dsc-sourceRowTaken' : 'dsc-sourceRow' },
                        h('input', {
                          className: 'dsc-check',
                          type: 'checkbox',
                          checked: chosen.includes(skill.name),
                          disabled: isTaken,
                          onChange: () => toggle(skill.name),
                        }),
                        h('span', { className: 'dsc-sourceName' }, skill.name),
                        h('span', { className: 'dsc-sourceDesc' }, skill.description),
                        skill.imported ? h('span', { className: 'dsc-badge' }, t('importTaken')) : null,
                      )
                    }),
              ),
            ),
          )
          body.push(
            h(
              'div',
              { className: 'dsc-pathRow', key: 'bulk' },
              h(P.Button, { variant: 'ghost', size: 'sm', onClick: () => patch({ names: selectable.map((skill) => skill.name) }) }, t('importSelectAll')),
              h(P.Button, { variant: 'ghost', size: 'sm', onClick: () => patch({ names: [] }) }, t('importClearAll')),
              h('div', { className: 'dsc-pathText' }, `${t('importSelected')} ${chosen.length}`),
            ),
          )
          body.push(
            h(
              'label',
              { className: 'dsc-sourceRow', key: 'overwrite' },
              h('input', {
                className: 'dsc-check',
                type: 'checkbox',
                checked: dialog.overwrite === true,
                onChange: (event) => patch({ overwrite: event.target.checked, names: [], result: null }),
              }),
              h('span', null, t('importOverwrite')),
            ),
          )
          body.push(field(t('whereLabel'), h(TargetPicker, { categories: view.categories, t, value: dialog.categoryId ?? UNCATEGORIZED, onChange: (value) => patch({ categoryId: value }) })))
        }

        run = async () => {
          if (active === null) return
          if (chosen.length === 0) {
            patch({ error: t('importNothing') })
            return
          }
          const categoryId = dialog.categoryId ?? UNCATEGORIZED
          const result = await mutate('skills.import', {
            sourceId: active.id,
            names: chosen,
            overwrite: dialog.overwrite === true,
            categoryId: categoryId === UNCATEGORIZED ? null : categoryId,
          })
          if (!result.ok) {
            patch({ error: result.error })
            return
          }
          // Stay open: an import can partly succeed, and the badges below need
          // to catch up with it.
          patch({
            names: [],
            error: null,
            result: { imported: result.payload.imported ?? [], skipped: result.payload.skipped ?? [] },
          })
          await loadSources()
        }
      }

      return h(
        'div',
        { className: 'dsc-dialogMask', role: 'presentation', onPointerDown: (event) => event.stopPropagation() },
        h(
          'div',
          { className: cx('dsc-dialog', dialog.kind === 'import' && 'dsc-dialogWide'), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('h3', { className: 'dsc-dialogTitle' }, title),
          ...body,
          // A failure keeps the dialog open and reports itself here, next to the
          // input that caused it.
          dialog.error === null || dialog.error === undefined ? null : h('div', { className: 'dsc-dialogError' }, dialog.error),
          h(
            'div',
            { className: 'dsc-dialogActions' },
            h(P.Button, { variant: 'ghost', size: 'sm', onClick: close }, t('cancel')),
            // Destructive confirms read as danger text on an outline button
            // rather than as the accent action the eye goes to first.
            h(
              P.Button,
              {
                variant: danger ? 'outline' : 'primary',
                size: 'sm',
                className: danger ? 'dsc-danger' : undefined,
                onClick: () => {
                  void run?.()
                },
              },
              primaryLabel,
            ),
          ),
        ),
      )
    }

    /**
     * A controlled text field, single-line or multi-line.
     *
     * Controlled rather than self-managed: the dialog's submit button lives
     * outside the field, and reading values back through a registered closure
     * made a failed submit indistinguishable from a successful one.
     *
     * @param props - value, placeholder, and the change/submit handlers.
     * @returns the input or textarea element.
     */
    function TextField({ value, placeholder, multiline, autoFocus, onEnter, onChange }) {
      const shared = {
        className: multiline === true ? 'dsc-input dsc-textarea' : 'dsc-input',
        value,
        placeholder,
        // eslint-disable-next-line no-autofocus
        autoFocus: autoFocus === true,
        onChange: (event) => onChange(event.target.value),
      }
      if (multiline === true) return h('textarea', { ...shared, rows: 6 })
      return h('input', {
        ...shared,
        type: 'text',
        onKeyDown: (event) => {
          if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
        },
      })
    }

    /**
     * The destination picker: 未分类 first, then every category indented.
     * @param props - the tree, the dictionary, and the controlled value.
     * @returns the picker element.
     */
    function TargetPicker({ categories, t, value, onChange, rootLabel, exclude }) {
      // The only non-folder destination is the container itself. For a skill
      // that is 未分类 ("it belongs to no folder"); for a folder it is 顶级
      // ("it sits at the top level"), so the label is the caller's to choose.
      const skip = new Set(exclude ?? [])
      const options = [
        { id: UNCATEGORIZED, name: rootLabel ?? t('uncategorized'), depth: 1 },
        ...flattenTree(categories).filter((option) => !skip.has(option.id)),
      ]
      return h(
        'div',
        { className: 'dsc-targetList', role: 'radiogroup', 'aria-label': t('moveTitle') },
        options.map((option) =>
          h(
            'button',
            {
              key: option.id,
              type: 'button',
              role: 'radio',
              'aria-checked': value === option.id ? 'true' : 'false',
              className: value === option.id ? 'dsc-targetRow dsc-targetRowActive' : 'dsc-targetRow',
              style: { paddingLeft: `${10 + (option.depth - 1) * 14}px` },
              onClick: () => onChange(option.id),
            },
            h(P.IconFolderOpen16, { size: 16 }),
            h('span', null, option.name),
          ),
        ),
      )
    }

    // ----------------------------------------------------------------- helpers

    /**
     * Create a minimal external store.
     * @param initial - starting value.
     * @returns get/set/subscribe handles.
     */
    function createSignal(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          if (Object.is(value, next)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * Bind a signal to React's external-store subscription.
     * @param signal - signal from {@link createSignal}.
     * @returns the current value.
     */
    function useSignal(signal) {
      return React.useSyncExternalStore(signal.subscribe, signal.get, signal.get)
    }

    /**
     * Join class names, dropping the falsy ones.
     * @param values - class names or falsy values.
     * @returns the class attribute value.
     */
    function cx(...values) {
      return values.filter(Boolean).join(' ')
    }

    /**
     * Flatten a category tree into render order.
     * @param tree - nested nodes.
     * @param depth - starting depth (top level is 1).
     * @returns one entry per node, with its depth.
     */
    function flattenTree(tree, depth = 1) {
      const rows = []
      for (const node of tree) {
        rows.push({ id: node.id, name: node.name, depth })
        rows.push(...flattenTree(node.children ?? [], depth + 1))
      }
      return rows
    }

    /**
     * Flatten only the nodes currently visible (i.e. skipping collapsed subtrees).
     * @param tree - nested nodes.
     * @param collapsed - map of id to true for collapsed nodes.
     * @param depth - starting depth.
     * @returns the visible rows.
     */
    function treeRows(tree, collapsed, depth = 1) {
      const rows = []
      for (const node of tree) {
        rows.push({ id: node.id, name: node.name, depth, hasChildren: (node.children ?? []).length > 0 })
        if (collapsed[node.id] !== true) rows.push(...treeRows(node.children ?? [], collapsed, depth + 1))
      }
      return rows
    }

    /**
     * Whether a category sits at the top level.
     * @param tree - nested nodes.
     * @param id - category id.
     * @returns true when the node is a direct child of the root.
     */
    function isTopLevel(tree, id) {
      return tree.some((node) => node.id === id)
    }

    /**
     * Find a category node by id.
     * @param tree - nested nodes.
     * @param id - category id, or the uncategorized sentinel.
     * @returns the node, or null.
     */
    function findNode(tree, id) {
      if (id === null || id === undefined || id === UNCATEGORIZED) return null
      for (const node of tree) {
        if (node.id === id) return node
        const found = findNode(node.children ?? [], id)
        if (found !== null) return found
      }
      return null
    }

    /**
     * Collect a node's id together with every descendant id.
     * @param node - subtree root.
     * @returns the ids, root first.
     */
    function subtreeIds(node) {
      return [node.id, ...(node.children ?? []).flatMap(subtreeIds)]
    }

    /**
     * Find the parent id of a category.
     * @param tree - nested nodes.
     * @param id - category id.
     * @returns the parent id, null at the top level, or undefined when absent.
     */
    function parentIdOf(tree, id) {
      const walk = (nodes, parentId) => {
        for (const node of nodes) {
          if (node.id === id) return parentId
          const found = walk(node.children ?? [], node.id)
          if (found !== undefined) return found
        }
        return undefined
      }
      return walk(tree, null)
    }

    /**
     * Describe the hovered tree node for the preview strip.
     * @param preview - hovered node description, or null.
     * @param t - dictionary.
     * @returns the preview text.
     */
    function previewText(preview, t) {
      if (preview === null) return t('dragHint')
      const kind = preview.kind === 'category' ? t('previewCategory') : preview.kind === 'skill' ? t('previewSkill') : ''
      return kind === '' ? preview.name : `${kind} · ${preview.name}`
    }

    /**
     * Read a JSON response without assuming the body parses.
     * @param response - fetch response.
     * @returns the parsed payload.
     * @throws {Error} when the response is not ok, carrying the server's message.
     */
    async function readJson(response) {
      let payload = {}
      try {
        const parsed = await response.json()
        if (parsed !== null && typeof parsed === 'object') payload = parsed
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * Normalize an unknown thrown value into a message.
     * @param error - thrown value.
     * @returns the message text.
     */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    exports.name = 'dsh-skill-center'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

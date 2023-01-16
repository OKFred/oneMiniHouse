const app = getApp();

Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        footerArr: {
            type: Array,
        }, //菜单列表，支持编辑，删除之类的场景
    },
    data: {},
    ready: function () {},
    methods: {
        onNav(e) {
            let { obj } = e.currentTarget.dataset; //item
            let { page, type = "redirectTo", disabled } = obj || {};
            if (disabled) return console.log("按钮已禁用");
            return app.onNav({ pageName: page, navType: type });
        },
    },
});

const app = getApp();

Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        pageName: {
            type: String,
        },
        headerColor: {
            type: String,
            value: "white",
        },
        showBackButton: {
            type: Boolean,
        },
    },
    data: {},
    ready: function () {},
    methods: {
        onNavback() {
            console.log("点击了返回按钮");
            app.onNavBack();
        },
    },
});

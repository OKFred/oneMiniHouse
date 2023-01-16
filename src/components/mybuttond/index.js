Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        text: {
            type: String,
        },
        icon: {
            type: String,
        },
        color: {
            type: String,
        },
        size: {
            type: String,
        },
        shape: {
            type: String,
        },
        disabled: {
            type: Boolean,
        },
    },
    data: {},
    ready: function () {},
    methods: {},
});

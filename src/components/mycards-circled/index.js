let myself;

Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        checkType: {
            type: String,
        },
        thisTime: {
            type: String,
        },
        thisDate: {
            type: String,
        },
    },
    data: {},
    ready: function () {
        myself = this;
    },
    methods: {
        onCheck() {
            console.log("点击了打卡按钮");
            let { checkType } = this.data;
            this.triggerEvent("onChildFn", {
                fn: "onCheck",
                params: { checkType },
            });
        },
    },
});

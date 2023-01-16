Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        tabArr: {
            type: Array,
        }, //所有标签
    },
    data: {
        currentTab: "",
    },
    ready: function () {},
    methods: {
        onTabChange(e) {
            console.log("切换标签", e.detail);
            let { title } = e.detail;
            this.setData({ currentTab: title });
            this.triggerEvent("onChildFn", { fn: "onTabChange", params: { currentTab: title } });
            this.triggerEvent("childfn", { fn: "onTabChange", params: { currentTab: title } }); //兼容taro
        },
    },
});

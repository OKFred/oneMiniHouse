Component({
    options: {
        // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
        addGlobalClass: true,
        multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
    },
    properties: {
        formArr: {
            type: Array,
            observer: function (newValue, oldValue) {
                if (newValue && newValue.length) {
                    this.setData({ _formArr: newValue.filter((obj) => !obj.hidden) });
                } //通过hidden 关键词 隐藏某项表单值
            },
        },
        parent: {
            type: String,
            value: "default",
        },
    },
    data: {
        _formArr: [],
        currentRegion: [24, 2, 2], //云南省,玉溪市,通海县
    },
    ready: function () {},
    methods: {
        onEdit(e) {
            this.triggerEvent("onChildFn", {
                fn: "onEdit",
                params: { e },
            });
        },
        onEditComplete(e) {
            this.triggerEvent("onChildFn", {
                fn: "onEditComplete",
                params: { e },
            });
        },
        onRegionSelection(e) {
            let { currentRegion } = this.data;
            console.log(currentRegion);
            this.triggerEvent("onChildFn", {
                fn: "onRegionSelection",
                params: { e },
            });
        },
    },
});

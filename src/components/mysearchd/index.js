Component({
  options: {
    // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
    addGlobalClass: true,
    multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
  },
  properties: {
    showSearch: {
      type: Boolean,
    }, //是否启用搜索
    searchHolder: {
      type: String,
    }, //搜索提示
  },
  data: {
    userSearch: "",
  },
  ready: function () {},
  methods: {
    onSearch(e) {
      let { userSearch } = this.data;
      console.log("搜索", { userSearch });
      this.triggerEvent("onChildFn", {
        fn: "onSearch",
        params: { userSearch },
      });
      this.triggerEvent("childfn", { fn: "onSearch", params: { userSearch } }); //兼容taro
    },
  },
});

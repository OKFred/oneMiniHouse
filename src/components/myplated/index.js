Component({
  options: {
    // 这个配置决定是否由 `app.wxss` 和页面 `wxss` 中的样式定义来决定
    addGlobalClass: true,
    multipleSlots: true, // 在组件定义时的选项中启用多 slot 支持
  },
  properties: {
    showPlate: {
      type: Boolean,
      value: false,
      observer: function (newValue, oldValue) {
        if (newValue) {
          this.openKeyboard();
        }
      },
    },
  },
  data: {
    // 省份简写
    provinces: [
      ["云", "京", "沪", "粤", "津", "冀", "晋", "蒙"],
      ["辽", "吉", "黑", "苏", "浙", "皖", "闽", "赣", "鲁", "豫"],
      ["鄂", "湘", "桂", "琼", "渝", "川", "贵", "藏", "陕", "甘"],
      ["青", "宁", "新"],
    ],
    // 车牌输入
    numbers: [
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
      ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"],
      ["L", "M", "N", "P", "Q", "R", "S", "T", "U", "V"],
      ["W", "X", "Y", "Z", "港", "澳", "学", "挂"],
    ],
    carnum: [],
    showNewPower: false,
    KeyboardState: false,
  },
  ready: function () {},
  methods: {
    // 选中点击设置(车牌号)
    bindChoose(e) {
      if (!this.data.carnum[6] || this.data.showNewPower) {
        let arr = [];
        arr[0] = e.target.dataset.val;
        this.data.carnum = this.data.carnum.concat(arr);
        this.setData({
          carnum: this.data.carnum,
        });
      }
    },
    bindDelChoose() {
      if (this.data.carnum.length != 0) {
        this.data.carnum.splice(this.data.carnum.length - 1, 1);
        this.setData({
          carnum: this.data.carnum,
        });
      }
    },
    showPowerBtn() {
      this.setData({
        showNewPower: true,
        KeyboardState: true,
      });
    },
    closeKeyboard() {
      this.setData({
        KeyboardState: false,
      });
    },
    openKeyboard() {
      this.setData({
        KeyboardState: true,
      });
    },
    onPlateEdit(e) {
      this.onPlateClose();
      this.triggerEvent("onChildFn", { fn: "onPlateEdit", params: {} });
      this.triggerEvent("childfn", { fn: "onPlateEdit", params: {} }); //兼容taro
    }, //车牌号自由输入 //⚠️
    // 提交车牌号码
    submitNumber() {
      let that = this;
      if (that.data.carnum[6]) {
        // wx.showLoading();
        let number;
        if (!that.data.showNewPower) {
          if (that.data.carnum[6]) {
            number =
              that.data.carnum[0] +
              that.data.carnum[1] +
              // "·" +
              that.data.carnum[2] +
              that.data.carnum[3] +
              that.data.carnum[4] +
              that.data.carnum[5] +
              that.data.carnum[6];
            that.addCarNumber(number);
          } else {
            wx.showToast({
              title: "请填写完整的车牌号码",
              icon: "none",
              duration: 2000,
            });
          }
        } else {
          if (that.data.carnum[7]) {
            number =
              that.data.carnum[0] +
              that.data.carnum[1] +
              // "·" +
              that.data.carnum[2] +
              that.data.carnum[3] +
              that.data.carnum[4] +
              that.data.carnum[5] +
              that.data.carnum[6] +
              that.data.carnum[7];
            that.addCarNumber(number);
          } else {
            wx.showToast({
              title: "请填写完整的车牌号码",
              icon: "none",
              duration: 2000,
            });
          }
        }
      } else {
        wx.showToast({
          title: "请填写完整的车牌号码",
          icon: "none",
          duration: 2000,
        });
      }
    },
    onPlateClose() {
      this.setData({ KeyboardState: false });
      this.triggerEvent("onChildFn", {
        fn: "onPlateClose",
        params: { showPlate: false },
      });
      this.triggerEvent("childfn", {
        fn: "onPlateClose",
        params: { showPlate: false },
      }); //兼容taro
    },
    addCarNumber(plateNumber) {
      this.setData({ KeyboardState: false });
      this.triggerEvent("onChildFn", {
        fn: "onPlateConfirm",
        params: { plateNumber },
      });
      this.triggerEvent("childfn", {
        fn: "onPlateConfirm",
        params: { plateNumber },
      }); //兼容taro
    }, // 最后实现了输入车牌号码的功能 以及新增新能源车辆的功能
  },
});

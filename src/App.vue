<script setup>
//框架引入
import { onLaunch, onHide } from "@dcloudio/uni-app";
const { onNav, onNavBack, globalData } = globalThis.app;

onLaunch(() => {
  console.log('应用加载');
  onHideTabBar()

});

onHide(() => {
  console.log('应用隐藏')
});

function onHideTabBar() {
  globalData['平台'] === '嵌入网页' ? uni.hideTabBar() : ""
}
</script>

<style lang="scss">
// uview-plus/index.scss
@import "uview-plus/index.scss";



.u-toast__content__text {
  font-size: 1.1rem !important;
  font-weight: bold !important;
  color: #000 !important;
}

.u-tag__text {
  white-space: nowrap;
  font-size: 2vh !important;
  font-weight: bold;
}

:deep(.u-navbar__content__title) {
  font-size: 34rpx !important;
  color: #000 !important;
  // font-weight: bold !important;
}


// @import "./wxcomponents/@vant/weapp/common/index.wxss";
</style>

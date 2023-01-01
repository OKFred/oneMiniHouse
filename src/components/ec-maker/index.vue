<template>
  <view class="ec-container">
    <ec-canvas
      canvas-id="echart"
      id="echart"
      force-use-old-canvas="true"
      :ec="localObj.ec"
    ></ec-canvas>
  </view>
</template>

<script>
import { reactive, watch, onMounted } from "vue";
import * as echarts  from "./ec-canvas/echarts.js";

//父系入参
const props = defineProps({
  parentObj: Object,
});

onMounted(() => {
  console.log("加载组件");
});

watch(
  () => props.parentObj.configObj,
  (newValue, oldValue) => {
    if (newValue && newValue.option) {
      console.log("数据配置已就位，准备加载图表");
      initChart();
    }
  }
  // { immediate: true }
);

//本地变量和函数
let localObj = reactive({
  chart: null,
  ec: {
    lazyLoad: true,
  }, // 将 lazyLoad 设为 true 后，需要手动初始化图表
  isLoaded: false,
  isDisposed: false,
});

function dispose() {
  if (localObj.chart) {
    localObj.chart.dispose();
  }
  localObj.isDisposed = true;
  console.log("图表已销毁");
}
function initChart() {
  let { configObj } = localObj;
  let { option, id } = configObj || {};
  if (!option) return console.log("选项未就位");
  if (!localObj.ecComponent)
    localObj.ecComponent = localObj.selectComponent("#echart");
  localObj.ecComponent.init((canvas, width, height) => {
    let chart = echarts.init(canvas, null, {
      width,
      height,
    });
    canvas.setChart(chart);
    chart.setOption(option);
    // 将图表实例绑定到 localObj 上，可以在其他成员函数（如 dispose）中访问
    localObj.chart = chart;
    localObj.isLoaded = true;
    localObj.isDisposed = false;
    console.log("已加载图表");
    return chart;
  });
}
</script>

<style scoped>
.ec-container {
  width: 100%;
  height: 35vh;
}

ec-canvas {
  width: 100%;
  height: 100%;
}
</style>

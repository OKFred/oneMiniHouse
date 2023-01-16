<template>
  <view class="ec-container">
    <ec-canvas canvas-id="echart" id="echart" ref="echart" :ec="localObj.echartObj.ec" />
  </view>
  <view style="margin-top: 1rem" />
  <view style="width: 100%" @tap="onToggleGraph">
    <mybuttond :parentObj="localObj.echartObj.buttons" />
  </view>
</template>

<script setup>
//框架引入
import Taro from "@tarojs/taro";
import {
  reactive,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入
import mybuttond from "@/src/components/mybuttond/index.vue"; //引入组件
import echarts from "@/src/components/ec-canvas/echarts.js"; //引入组件

definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
  },
});

//父系入参
const { onNav, onNavBack } = globalThis.app;

const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  // debug: true,
  echartObj: {
    chart: null,
    ec: {
      // onInit: initChart,
      lazyLoad: true,
    }, // 将 lazyLoad 设为 true 后，需要手动初始化图表
    isLoaded: false,
    isDisposed: false,
    isPaused: false,
    optionObj: {
      animationDuration: 800,
      title: {
        show: false
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          animation: false
        }
      },
      /*       toolbox: {
              feature: {
                saveAsImage: {}
              }
            }, */
      legend: {
        type: 'scroll',
        animation: false,
        data: ['电压(V)', '电流(A)', '有功(W)', '无功(var)', '视在(VA)', '功率因数', '频率(Hz)']
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '1%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: [],
        splitLine: {
          show: false
        }
      },
      yAxis: {
        type: 'value',
        splitLine: {
          show: false
        }
      },
      series: [
        {
          name: '电压(V)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '电流(A)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '有功(W)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '无功(var)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '视在(VA)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '功率因数',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '频率(Hz)',
          type: 'line',
          smooth: true,
          data: [],
        }
      ]
    },
    initChart,
    dispose,
    buttons: {
      text: "加载中",
      color: 'red-plain',
      size: 'medium'
    },
  }
});

let graphInterval = null; //定时器
onMounted(() => {
  console.log('进入页面')
  graphInterval = setInterval(() => {
    if (props.localObj.echartObj.isPaused) return;
    initChart();
  }, 3000)
})

onBeforeUnmount(() => {
  console.log('离开页面')
  clearInterval(graphInterval);
})

function dispose() {
  if (props.localObj.echartObj.chart) {
    props.localObj.echartObj.chart.dispose();
    props.localObj.echartObj.isDisposed = true;
  }
}

function onToggleGraph() {
  console.log('图表状态切换');
  props.localObj.echartObj.isPaused = !props.localObj.echartObj.isPaused;
  props.localObj.echartObj.buttons.text = props.localObj.echartObj.isPaused ? '已暂停' : '加载中';
  props.localObj.echartObj.buttons.color = props.localObj.echartObj.isPaused ? 'blue-plain' : 'red-plain';
}

function initChart() {
  const current = Taro.getCurrentInstance()
  current.page.selectComponent('#echart').init((canvas, width, height) => {
    const chart = echarts.init(canvas, null, {
      width,
      height,
    });
    canvas.setChart(chart);
    chart.setOption(props.localObj.echartObj.optionObj);
    props.localObj.echartObj.isLoaded = true;
    props.localObj.echartObj.chart = chart;
    return chart;
  })
}
setTimeout(initChart, 500);


watch(
  () => props.localObj.formCollection['主表单'],
  (newValue, oldValue) => {
    if (newValue && newValue.length > 0) {
      let voltageArr = newValue.map(obj => obj.voltage?.toFixed(2));
      let currentArr = newValue.map(obj => obj.current?.toFixed(2));
      let active_powerArr = newValue.map(obj => (1000 * obj.active_power)?.toFixed(2));
      let reactive_powerArr = newValue.map(obj => (1000 * obj.reactive_power)?.toFixed(2));
      let apparent_powerArr = newValue.map(obj => (1000 * obj.apparent_power)?.toFixed(2));
      let power_factorArr = newValue.map(obj => obj.power_factor?.toFixed(2));
      let frequencyArr = newValue.map(obj => obj.frequency?.toFixed(2));
      let timeArr = newValue.map(obj => new Date(obj.query_time).Format('hh:mm:ss'));
      let { xAxis, series, legend } = props.localObj.echartObj.optionObj;
      xAxis.data = timeArr;
      let legendArr = ['电压(V)', '电流(A)', '有功(W)', '无功(var)', '视在(VA)', '功率因数', '频率(Hz)'];
      let dataArr = [voltageArr, currentArr, active_powerArr, reactive_powerArr, apparent_powerArr, power_factorArr, frequencyArr];
      // legend.data = legendArr;
      legendArr.forEach((name, index) => {
        series[index] = {
          name,
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: dataArr[index]
        }
      })
    }
  },
  { deep: true },
);

</script>

<style>
.ec-container {
  width: 100%;
  height: 50vh;
}

ec-canvas {
  width: 100%;
  height: 100%;
}
</style>

gsap.from(".Landing",{
    opacity:0,
    y:70,
    duration:1,
    delay:0.5
})

gsap.from(".LandingP",{
    opacity:0,
    y:70,
    duration:1 ,
    delay:0.5
})

gsap.from(".btn",{
    opacity:0,
    y:70,
    duration:1 ,
    delay:0.5
})

gsap.from(".info",{
    opacity:0,
    x:-10,
    stagger:1,
    scrollTrigger:{
        trigger:"#how",
        start:"top 0",
        end:"top -800",
        scrub:0.2,
        pin:true,
    }
})

gsap.from(".benefits",{
    opacity:0,
    duration:1,
    scrollTrigger:{
        trigger:".benefits",
        scroller:"body",
        start:"top 55%",
        end:"top 60%"
    }
})

gsap.to(".infoContainer",{
    color:"white",
    duration:1,
    scrollTrigger:{
        trigger:".infoContainer",
        scroller:"body",
        start:"top 55%",
        end:"top 60%"
    }
})
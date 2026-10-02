/* Road counterpart of Lab4 profile6: Response2 stays in the base image.
 * Only replace LDR r3,[r5,#20]; CMP r2,r3 at080031cc.
 * r0=previous, r1=requested, r2=absolute delta, r5=mode state.
 * Scale positive rising drive in Sport; brake/regen paths stay stock.
 * No bench dispatcher, synthetic throttle, lease or extra state.
 */
.syntax unified
.thumb
.section .text
.global road_slew4
.type road_slew4,%function
.thumb_func
road_slew4:
    push {r0,r1,r2,lr}
    ldr r3,[r5,#20]
    cmp r1,#0
    ble slew_compare
    cmp r1,r0
    ble slew_compare
    ldrb r0,[r5]
    cmp r0,#4
    bne slew_compare
    ldr r0,brake_input
    ldrb r0,[r0]
    cmp r0,#60
    bhi slew_compare
    ldr r0,brake_active
    ldrh r0,[r0]
    cmp r0,#0
    bne slew_compare
    ldr r0,regen_active
    ldrb r0,[r0]
    cmp r0,#0
    bne slew_compare
    /* Real profile values are small. Never overflow a signed32 bound. */
    lsrs r0,r3,#29
    bne slew_compare
    lsls r3,r3,#2
slew_compare:
    cmp r2,r3
    pop {r0,r1,r2,pc}
.balign 4
brake_input: .word 0x20000327
brake_active: .word 0x2000154c
regen_active: .word 0x20001575
.size road_slew4,.-road_slew4

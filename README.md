
# XZZPCB-ImHex
XZZPCB file format reader using ImHex ([WerWolv/ImHex](https://github.com/WerWolv/ImHex))

With help from Paul Daniels ([@inflex](https://github.com/inflex)), Muerto ([@MuertoGB](https://github.com/MuertoGB)), and more

(Decryption not necessary to open in my OBV fork, only used to examine the file structure in ImHex) 

**XZZPCB Boardviewer**

https://slimeinacloak.github.io/XZZPCB-ImHex/

**XZZPCB_Decrypt.py usage:**

Decrypt and write to single file:
    
    python .\XZZPCB_Decrypt.py -d -f 'Example PCB Files\SWITCH OLED-HEG-CPU-01-PCB Layer.pcb'

Decrypt part blocks and write to seperate files:
    
    python .\XZZPCB_Decrypt.py -e -f 'Example PCB Files\SWITCH OLED-HEG-CPU-01-PCB Layer.pcb'


**Translate_GB2312.py usage:**

    python .\Translate_GB2312.py
    Enter bytes separated by spaces: 46 3A 5C C9 BD B6 AB C9 F3 BA CB B5 C4 50 43 42 CE C4 BC FE 5C 50 43 42 CD BC C6 AC 5C D2 D1 CD EA B3 C9 5C 53 77 69 74 63 68 20 4F 4C 45 44 2D 48 45 47 2D 43 50 55 2D 30 31 2D B5 D7 CD BC 5C 42 2D 4A 49 50 2E 6A 70 67
    Translated output: F:\山东审核的PCB文件\PCB图片\已完成\Switch OLED-HEG-CPU-01-底图\B-JIP.jpg
    

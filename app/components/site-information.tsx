"use client";

import Link from "next/link";
import { ArrowUpDown, Files, FolderDown, Laptop, ShieldCheck, Users } from "lucide-react";
import { useAccess } from "@/hooks/use-access";
import { LARGE_FILE_RELEASE_QUALIFIED } from "@/lib/release-qualification";

const features = [
  { icon: Laptop, title: "Phone. Computer. Together.", text: "Send between your phone and computer, whichever way you need." },
  { icon: Files, title: "Everything in one send.", text: "Share several files together, or keep a folder together in a ZIP." },
  { icon: Users, title: "One person or everyone.", text: "Send privately to one person or share with your whole approved group." },
  { icon: FolderDown, title: "A place for your files.", text: "Choose where files land when your browser supports it, or use its usual downloads." },
  { icon: ShieldCheck, title: "Your files stay yours.", text: "We don’t keep copies of the files you transfer. You choose who joins and what to accept." },
  { icon: ArrowUpDown, title: "Sharing goes both ways.", text: "Send, receive and chat in the same session. There’s no need to start over to swap roles." },
];

const steps = [
  { title: "Make a little sharing space.", text: "Create a session and share its QR code or invitation link with your other device or group." },
  { title: "Let your people in.", text: "Approve the people joining. Only share the private invitation with people you trust." },
  { title: "Pick it. Send it. Accept it.", text: "Choose your files and recipients. Each person decides which incoming files to accept." },
  { title: "Keep the connection open.", text: "Leave both pages open and devices awake until the files finish saving." },
];

export function SiteInformation() {
  const { config } = useAccess();
  const demonstrationAds = config?.adsMode === "demo";
  const questions = [
    { question: "How large can my files be?", answer: LARGE_FILE_RELEASE_QUALIFIED
      ? "Up to 100 GB per file on supported browsers, with enough free storage. The receiving browser must be able to save directly to a file or folder. Some phone and browser combinations have smaller receiving limits. Keep both pages open until saving finishes."
      : "Large-file sharing depends on your browser and available storage. Transfers up to 100 GB are being validated; that size is not yet a verified promise. For large files, the receiving browser needs to save directly to a file or folder. Some phone browsers have smaller download limits." },
    { question: "Does it work between Android, iPhone, Mac and Windows?", answer: "Yes, through supported browsers. You can connect a phone to a computer, two computers or a group. Saving options and large-file support differ between browsers; an iPhone browser may not receive the same large files as desktop Chrome or Edge." },
    { question: "Do you keep my files?", answer: <>We don’t store copies of the files you transfer or keep your session chat on our application server. Account and connection information are handled separately. Read our <Link prefetch={false} href="/privacy">privacy information</Link> for details.</> },
    { question: "Do both devices need the same Wi-Fi?", answer: "No. The same Wi-Fi or hotspot can provide a faster local route. Devices on different networks need a working internet connection, and some networks may prevent them from connecting." },
    { question: "Can I use it without internet?", answer: "Opening the site, initial pairing and reconnecting after a refresh currently need internet. Once devices have an established local connection, their file transfer can continue without internet. Stay on the same Wi-Fi or hotspot and keep both pages open." },
    { question: "Can I close the page or lock my phone?", answer: "Keep both pages open and devices awake. Closing, refreshing, locking the screen or switching away can interrupt a transfer. A refresh may restore your session connection, but it does not restore an interrupted file’s progress." },
    { question: "Can I choose a download folder?", answer: "Yes, when your browser allows direct saving. Choose a destination before accepting a large file. Otherwise, use Download or Save as… and your device’s normal save controls. These options depend on your browser." },
    { question: "Can I send a folder?", answer: "Yes. Choose a folder or drop it into the sharing area where supported. It becomes a ZIP that the recipient can open with their file manager. Preparation needs free space on your device. If your browser cannot prepare it, make a ZIP in Finder, Files or your file manager, then choose that file." },
    { question: "Does Bluetooth alone work?", answer: "No. Browser-to-browser Bluetooth file transfer is not supported. Use a Wi-Fi or hotspot connection for this website, or your device’s built-in sharing feature for another way to send." },
    { question: "Why does speed vary?", answer: "Speed depends on both devices, their storage and the connection between them. Sharing the same Wi-Fi or hotspot often helps. Premium’s Maximum speed benefit removes the Standard application limit; it does not create extra network capacity, guarantee a speed or reserve your Wi-Fi for this page." },
    { question: "How do free and Premium sharing work?", answer: <>{demonstrationAds
      ? "This local demonstration asks Standard senders to complete one clearly labelled test ad per Send batch. Test ads earn no advertising revenue. "
      : "Live send advertisements are not enabled in this build, so unavailable ads let the current send proceed free. "}When enabled with a compatible provider, one Send covers your selected files and recipients. Only the sender may see the prompt; connecting, receiving, accepting, chatting and saving need no ad. If an ad is unavailable, that batch can proceed free. Premium adds ad-free sharing and Maximum speed for one desktop and one mobile installation. <Link prefetch={false} href="/plans" target="_blank" rel="noopener noreferrer">See plans in a separate tab</Link>.</> },
  ];

  return <div className="site-information" data-testid="site-information">
    <section className="information-section" id="features" aria-labelledby="features-title">
      <div className="information-heading"><p className="eyebrow"><span />MADE FOR THE WAY YOU SHARE</p><h2 id="features-title">Less fuss. More possibilities.</h2><p>A few good reasons to bring your devices together.</p></div>
      <div className="feature-grid">{features.map(({ icon: Icon, title, text }) => <article className="feature-card" key={title}><span className="feature-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.6} /></span><h3>{title}</h3><p>{text}</p></article>)}</div>
    </section>
    <section className="information-section how-section" id="how-it-works" aria-labelledby="how-title">
      <div className="information-heading"><p className="eyebrow"><span />FROM HERE TO THERE</p><h2 id="how-title">How it works.</h2><p>Four small steps. No installation needed.</p></div>
      <ol className="how-steps">{steps.map((step, index) => <li key={step.title}><span className="how-number" aria-hidden="true">0{index + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
    </section>
    <section className="information-section faq-section" id="faq" aria-labelledby="faq-title">
      <div className="information-heading"><p className="eyebrow"><span />A LITTLE CLARITY</p><h2 id="faq-title">Good questions. Straight answers.</h2><p>What to expect before you send.</p></div>
      <div className="faq-list">{questions.map(({ question, answer }) => <details className="faq-item" key={question}><summary>{question}<span aria-hidden="true">+</span></summary><div className="faq-answer"><p>{answer}</p></div></details>)}</div>
    </section>
  </div>;
}
